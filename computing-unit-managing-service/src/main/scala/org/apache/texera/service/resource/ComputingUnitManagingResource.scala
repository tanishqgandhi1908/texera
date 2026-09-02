/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

package org.apache.texera.service.resource

import io.dropwizard.auth.Auth
import io.fabric8.kubernetes.api.model.Quantity
import io.fabric8.kubernetes.client.KubernetesClientException
import jakarta.annotation.security.RolesAllowed
import jakarta.ws.rs._
import jakarta.ws.rs.core.{MediaType, Response}
import org.apache.commons.lang3.StringUtils
import org.apache.texera.auth.JwtAuth.jwtClaims
import org.apache.texera.auth.{JwtAuth, SessionUser}
import org.apache.texera.common.config.KubernetesConfig.{
  cpuLimitOptions,
  gpuLimitOptions,
  maxNumOfRunningComputingUnitsPerUser,
  memoryLimitOptions
}
import org.apache.texera.common.config.{
  ComputingUnitConfig,
  EnvironmentalVariable,
  KubernetesConfig,
  StorageConfig
}
import com.typesafe.scalalogging.LazyLogging
import org.apache.texera.amber.core.storage.FileResolver
import org.apache.texera.dao.SqlServer
import org.apache.texera.dao.SqlServer.withTransaction
import org.apache.texera.dao.jooq.generated.enums.{
  PrivilegeEnum,
  UserRoleEnum,
  WorkflowComputingUnitTypeEnum
}
import org.apache.texera.dao.jooq.generated.tables.daos.{
  ComputingUnitUserAccessDao,
  UserDao,
  WorkflowComputingUnitDao
}
import org.apache.texera.dao.jooq.generated.tables.pojos.WorkflowComputingUnit
import org.apache.texera.service.resource.ComputingUnitManagingResource._
import org.apache.texera.service.util.{
  ComputingUnitHelpers,
  ComputingUnitManagingServiceException,
  InsufficientComputingUnitQuota,
  KubernetesClient,
  MounterClient,
  MounterRequestFailed
}
import org.jooq.{DSLContext, EnumType}
import play.api.libs.json._

import java.sql.Timestamp
import scala.annotation.unused
import scala.jdk.CollectionConverters.CollectionHasAsScala

object ComputingUnitManagingResource {
  private def context: DSLContext =
    SqlServer
      .getInstance()
      .createDSLContext()

  private def icebergEnvironmentVariables: Map[String, Any] = {
    val base = Map[String, Any](
      EnvironmentalVariable.ENV_ICEBERG_CATALOG_TYPE -> StorageConfig.icebergCatalogType
    )
    StorageConfig.icebergCatalogType match {
      case "rest" =>
        base ++ Map(
          EnvironmentalVariable.ENV_ICEBERG_CATALOG_REST_URI -> StorageConfig.icebergRESTCatalogUri,
          EnvironmentalVariable.ENV_ICEBERG_CATALOG_REST_WAREHOUSE_NAME -> StorageConfig.icebergRESTCatalogWarehouseName
        )
      case "postgres" =>
        base ++ Map(
          EnvironmentalVariable.ENV_ICEBERG_CATALOG_POSTGRES_URI_WITHOUT_SCHEME -> StorageConfig.icebergPostgresCatalogUriWithoutScheme,
          EnvironmentalVariable.ENV_ICEBERG_CATALOG_POSTGRES_USERNAME -> StorageConfig.icebergPostgresCatalogUsername,
          EnvironmentalVariable.ENV_ICEBERG_CATALOG_POSTGRES_PASSWORD -> StorageConfig.icebergPostgresCatalogPassword
        )
      case _ => base
    }
  }

  // Environment variables passed to the created computing unit(pod)
  private lazy val computingUnitEnvironmentVariables: Map[String, Any] =
    icebergEnvironmentVariables ++ Map(
      // Variables for saving the metadata of the results, i.e. URIs of results/stats
      EnvironmentalVariable.ENV_JDBC_URL -> StorageConfig.jdbcUrl,
      EnvironmentalVariable.ENV_JDBC_USERNAME -> StorageConfig.jdbcUsername,
      EnvironmentalVariable.ENV_JDBC_PASSWORD -> StorageConfig.jdbcPassword,
      // Variables for reading files & exporting results
      // LakeFS endpoint is passed to CU to make CU work in dev mode(using localhost & using default LakeFS credentials)
      // LakeFS credentials should NOT be passed to CU
      EnvironmentalVariable.ENV_LAKEFS_ENDPOINT -> StorageConfig.lakefsEndpoint,
      // S3 variables are passed to CU for R UDF large binary support
      EnvironmentalVariable.ENV_S3_ENDPOINT -> StorageConfig.s3Endpoint,
      EnvironmentalVariable.ENV_S3_REGION -> StorageConfig.s3Region,
      EnvironmentalVariable.ENV_S3_AUTH_USERNAME -> StorageConfig.s3Username,
      EnvironmentalVariable.ENV_S3_AUTH_PASSWORD -> StorageConfig.s3Password
    ) ++
      // File-service endpoints and amber settings, which only the deployment knows.
      // TODO: use AmberConfig for the amber items. Currently AmberConfig is only accessible in workflow-executing-service
      requiredComputingUnitEnv(EnvironmentalVariable.get)

  /**
    * Environment variables a computing unit cannot start without, and which have no
    * sensible default here because only the deployment knows them.
    *
    * The helm chart supplies every one, so in a chart deployment they are all present
    * and in any other topology -- a service started by hand, or from an IDE against a
    * cluster -- they are all absent. Read with Option.get, the first missing one threw
    * NoSuchElementException: None.get, which dropwizard renders as "There was an error
    * processing your request", naming neither the variable nor the cause.
    */
  private val requiredComputingUnitEnvNames: Seq[String] = Seq(
    EnvironmentalVariable.ENV_FILE_SERVICE_GET_DATASET_PRESIGNED_URL_ENDPOINT,
    EnvironmentalVariable.ENV_FILE_SERVICE_UPLOAD_ONE_FILE_TO_DATASET_ENDPOINT,
    EnvironmentalVariable.ENV_SCHEDULE_GENERATOR_ENABLE_COST_BASED_SCHEDULE_GENERATOR,
    EnvironmentalVariable.ENV_USER_SYS_ENABLED,
    EnvironmentalVariable.ENV_MAX_WORKFLOW_WEBSOCKET_REQUEST_PAYLOAD_SIZE_KB,
    EnvironmentalVariable.ENV_AUTH_JWT_SECRET
  )

  /**
    * The required variables, or a failure naming every one that is missing.
    *
    * Every absent variable is reported together rather than one at a time, because where
    * they are missing they are usually all missing -- failing on the first would mean six
    * attempts to discover that. Thrown as ServiceUnavailableException so the message
    * survives to the caller: dropwizard replaces the body of a generic 500, but passes a
    * WebApplicationException's own message through.
    */
  private[resource] def requiredComputingUnitEnv(
      lookup: String => Option[String]
  ): Map[String, String] = {
    val looked = requiredComputingUnitEnvNames.map(name => name -> lookup(name))
    val missing = looked.collect { case (name, None) => name }
    if (missing.nonEmpty) {
      throw new ServiceUnavailableException(
        "This deployment cannot create a computing unit: required configuration is not " +
          s"set. Missing environment variable(s): ${missing.mkString(", ")}."
      )
    }
    looked.collect { case (name, Some(value)) => name -> value }.toMap
  }

  case class WorkflowComputingUnitCreationParams(
      name: String,
      unitType: String,
      cpuLimit: String,
      memoryLimit: String,
      gpuLimit: String,
      jvmMemorySize: String,
      shmSize: String,
      uri: Option[String] = None,
      /** Curated image to start this unit from. Absent uses the deployment's default. */
      iid: Option[Int] = None
  )

  case class WorkflowComputingUnitResourceLimit(
      cpuLimit: String,
      memoryLimit: String,
      gpuLimit: String
  )

  case class WorkflowComputingUnitMetrics(
      cpuUsage: String,
      memoryUsage: String
  )

  case class DashboardWorkflowComputingUnit(
      computingUnit: WorkflowComputingUnit,
      status: String,
      metrics: WorkflowComputingUnitMetrics,
      isOwner: Boolean,
      accessPrivilege: EnumType,
      ownerAvatar: String,
      ownerName: String
  )

  case class ComputingUnitLimitOptionsResponse(
      cpuLimitOptions: List[String],
      memoryLimitOptions: List[String],
      gpuLimitOptions: List[String]
  )

  case class ComputingUnitTypesResponse(
      typeOptions: List[String]
  )

  /**
    * A model version mounted on a computing unit. `modelPath` is the readable
    * /model/ownerEmail/modelName/versionName (empty when it could not be reverse-resolved);
    * repositoryName/commitHash identify it to the mounter; mountPath is where it landed.
    */
  case class MountedModelInfo(
      modelPath: String,
      repositoryName: String,
      commitHash: String,
      mountPath: String
  )

  case class ModelMountParams(modelPath: String)

  /**
    * Base URL (scheme://authority) of file-service as the mounter should reach it, derived
    * from the presigned-URL endpoint this service is already configured with. The mounter's
    * GeeseFS mount targets the JWT-authenticated S3 proxy hosted at that root, so there is
    * no second endpoint to configure and no way for the two to disagree.
    */
  private lazy val fileServiceBaseUrl: String = {
    val endpoint = EnvironmentalVariable
      .get(EnvironmentalVariable.ENV_FILE_SERVICE_GET_DATASET_PRESIGNED_URL_ENDPOINT)
      .getOrElse("http://localhost:9092/api/dataset/presign-download")
    val uri = new java.net.URI(endpoint)
    s"${uri.getScheme}://${uri.getAuthority}"
  }

  private val JvmHeapSize = "^([0-9]+)([kKmMgG]?)$".r

  /**
    * Bytes for a JVM heap size, or None when the JVM would refuse it.
    *
    * Mirrors the JVM's own `-Xmx` grammar: digits with an optional k/m/g multiplier and
    * nothing else. In particular the Kubernetes forms (`Ki`/`Mi`/`Gi`) are rejected, even
    * though the adjacent memoryLimit field requires exactly those -- `-Xmx1Gi` makes the
    * JVM exit with "Invalid maximum heap size" before it can log anything useful, so the
    * pod only CrashLoopBackOffs and nothing points back at the input that caused it.
    */
  private[resource] def parseJvmHeapBytes(raw: String): Option[Long] =
    Option(raw).map(_.trim).flatMap {
      case JvmHeapSize(digits, unit) =>
        val multiplier = unit.toLowerCase match {
          case "k" => 1024L
          case "m" => 1024L * 1024
          case "g" => 1024L * 1024 * 1024
          case _   => 1L
        }
        // Computed as BigInt and range-checked, because Long arithmetic would wrap
        // silently on an absurd request and yield a plausible-looking small heap. A
        // zero heap is refused too -- the JVM does not accept -Xmx0 either.
        val bytes = BigInt(digits) * multiplier
        if (bytes > 0 && bytes.isValidLong) Some(bytes.toLong) else None
      case _ => None
    }
}

@Produces(Array(MediaType.APPLICATION_JSON))
@Path("/computing-unit")
class ComputingUnitManagingResource extends LazyLogging {

  private def getComputingUnitByCuid(ctx: DSLContext, cuid: Int): WorkflowComputingUnit = {
    val wcDao = new WorkflowComputingUnitDao(ctx.configuration())
    val unit = wcDao.fetchOneByCuid(cuid)

    if (unit == null) {
      throw new NotFoundException(s"Computing unit with cuid=$cuid does not exist.")
    }
    unit
  }

  private def userOwnComputingUnit(ctx: DSLContext, cuid: Integer, uid: Integer): Boolean = {
    getComputingUnitByCuid(ctx, cuid).getUid == uid
  }

  private def getSupportedComputingUnitTypes: List[String] = {
    val allTypes = WorkflowComputingUnitTypeEnum.values().map(_.getLiteral).toList
    allTypes.filter {
      case "local"      => ComputingUnitConfig.localComputingUnitEnabled
      case "kubernetes" => KubernetesConfig.kubernetesComputingUnitEnabled
      case _            => false // Any unknown types are disabled by default
    }
  }

  private def getComputingUnitResourceLimit(
      unit: WorkflowComputingUnit
  ): WorkflowComputingUnitResourceLimit = {
    unit.getType match {
      case WorkflowComputingUnitTypeEnum.local =>
        WorkflowComputingUnitResourceLimit("NaN", "NaN", "NaN")
      case WorkflowComputingUnitTypeEnum.kubernetes =>
        val podLimits: Map[String, String] = KubernetesClient.getPodLimits(unit.getCuid)

        // Get GPU value by finding the exact configured resource key
        val gpuValue = podLimits.getOrElse(KubernetesConfig.gpuResourceKey, "0")

        WorkflowComputingUnitResourceLimit(
          podLimits("cpu"),
          podLimits("memory"),
          gpuValue
        )
    }
  }

  @GET
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Produces(Array(MediaType.APPLICATION_JSON))
  @Path("/limits")
  def getComputingUnitLimitOptions(
      @Auth @unused user: SessionUser
  ): ComputingUnitLimitOptionsResponse = {
    ComputingUnitLimitOptionsResponse(cpuLimitOptions, memoryLimitOptions, gpuLimitOptions)
  }

  @GET
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Produces(Array(MediaType.APPLICATION_JSON))
  @Path("/types")
  def getComputingUnitTypes(
      @Auth @unused user: SessionUser
  ): ComputingUnitTypesResponse = ComputingUnitTypesResponse(getSupportedComputingUnitTypes)

  /**
    * Create a new pod for the given user ID.
    *
    * @param param The parameters containing the user ID.
    * @return The created pod or an error response.
    */
  @POST
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Consumes(Array(MediaType.APPLICATION_JSON))
  @Produces(Array(MediaType.APPLICATION_JSON))
  @Path("/create")
  def createWorkflowComputingUnit(
      param: WorkflowComputingUnitCreationParams,
      @Auth user: SessionUser
  ): DashboardWorkflowComputingUnit = {
    if (param.name.trim.isEmpty) {
      throw new ForbiddenException("Computing unit name cannot be empty.")
    }

    // Validate the unit type
    val cuType: WorkflowComputingUnitTypeEnum =
      WorkflowComputingUnitTypeEnum.lookupLiteral(param.unitType)

    // Validate that the type itself is supported
    if (!getSupportedComputingUnitTypes.contains(param.unitType))
      throw new ForbiddenException(
        s"Unit type '${param.unitType}' is not allowed. Valid options: " +
          getSupportedComputingUnitTypes.mkString(", ")
      )

    // For Kubernetes computing units, validate resource limits
    cuType match {

      // Kubernetes-specific checks
      case WorkflowComputingUnitTypeEnum.kubernetes =>
        if (!cpuLimitOptions.contains(param.cpuLimit))
          throw new ForbiddenException(
            s"CPU quantity '${param.cpuLimit}' is not allowed. " +
              s"Valid options: ${cpuLimitOptions.mkString(", ")}"
          )
        if (!memoryLimitOptions.contains(param.memoryLimit))
          throw new ForbiddenException(
            s"Memory quantity '${param.memoryLimit}' is not allowed. " +
              s"Valid options: ${memoryLimitOptions.mkString(", ")}"
          )
        if (!gpuLimitOptions.contains(param.gpuLimit))
          throw new ForbiddenException(
            s"GPU quantity '${param.gpuLimit}' is not allowed. " +
              s"Valid options: ${gpuLimitOptions.mkString(", ")}"
          )

        // Check if the shared-memory size is the valid size representation
        val shmQuantity =
          try {
            Quantity.parse(param.shmSize)
          } catch {
            case _: IllegalArgumentException =>
              throw new ForbiddenException(
                s"Shared-memory size '${param.shmSize}' is not a valid Kubernetes quantity " +
                  s"(examples: 64Mi, 2Gi)."
              )
          }

        val memQuantity = Quantity.parse(param.memoryLimit)

        // ensure /dev/shm upper bound ≤ container memory limit
        if (shmQuantity.compareTo(memQuantity) > 0)
          throw new ForbiddenException(
            s"Shared-memory size (${param.shmSize}) cannot exceed the total memory limit " +
              s"(${param.memoryLimit})."
          )

        // JVM heap must be expressed the way the JVM accepts, which is deliberately not
        // the Kubernetes syntax the memoryLimit field beside it requires.
        val jvmBytes = parseJvmHeapBytes(param.jvmMemorySize).getOrElse(
          throw new ForbiddenException(
            s"JVM memory size '${param.jvmMemorySize}' is not a valid JVM heap size. Use a " +
              "whole number with an optional k, m or g suffix (examples: 512m, 2g), not the " +
              s"Kubernetes form used by the memory limit (${param.memoryLimit})."
          )
        )

        // Compared in bytes. The previous integer-GB comparison truncated, so a 512Mi
        // limit read as 0 GB and a 2g heap against a 2500Mi limit compared as 2 vs 2.
        val memBytes = Quantity.getAmountInBytes(memQuantity).longValue()
        if (jvmBytes > memBytes)
          throw new ForbiddenException(
            s"JVM memory size (${param.jvmMemorySize}) cannot exceed the " +
              s"total memory limit (${param.memoryLimit})."
          )

      // Local-specific checks
      case WorkflowComputingUnitTypeEnum.local =>
        if (param.uri.forall(_.trim.isEmpty))
          throw new ForbiddenException("URI is required for local computing units")

      // Anything else (shouldn't happen if you keep supported types in sync)
      case _ =>
        throw new ForbiddenException(s"Unsupported computing-unit type: ${param.unitType}")
    }

    // Resolved before anything is written: starting from an image that has not finished
    // mirroring would leave a computing-unit row behind that can never run.
    val curatedImage: Option[String] = param.iid.map { iid =>
      CuratedImageResource
        .readyImageFor(iid)
        .getOrElse(
          throw new ForbiddenException(
            s"Image $iid is not available. It must exist and have finished mirroring."
          )
        )
    }

    withTransaction(context) { ctx =>
      val wcDao = new WorkflowComputingUnitDao(ctx.configuration())

      val units = wcDao
        .fetchByUid(user.getUid)
        .asScala
        .filter(_.getTerminateTime == null) // Filter out terminated units

      if (
        units.size >= maxNumOfRunningComputingUnitsPerUser && cuType == WorkflowComputingUnitTypeEnum.kubernetes
      ) {
        throw InsufficientComputingUnitQuota(maxNumOfRunningComputingUnitsPerUser)
      }

      val resourceJson: String = cuType match {
        // ── Kubernetes CU ───────────────────────────────────────
        case WorkflowComputingUnitTypeEnum.kubernetes =>
          Json.stringify(
            Json.obj(
              "cpuLimit" -> param.cpuLimit,
              "memoryLimit" -> param.memoryLimit,
              "gpuLimit" -> param.gpuLimit,
              "jvmMemorySize" -> param.jvmMemorySize,
              "shmSize" -> param.shmSize,
              // Recorded so the unit can say what it is running. The name is stored
              // alongside the id because a curated image can be removed while a unit
              // started from it is still up, and "which image is this" should still
              // have an answer then.
              "iid" -> param.iid,
              "imageName" -> param.iid.flatMap(CuratedImageResource.nameOf),
              "curatedImage" -> curatedImage,
              "nodeAddresses" -> Json.arr() // filled in later
            )
          )

        // ── Local CU ─────────────────────────────────────────────
        case WorkflowComputingUnitTypeEnum.local =>
          Json.stringify(
            Json.obj(
              "cpuLimit" -> "NaN",
              "memoryLimit" -> "NaN",
              "gpuLimit" -> "NaN",
              "jvmMemorySize" -> "NaN",
              "shmSize" -> "NaN",
              // user-supplied URI goes straight in
              "nodeAddresses" -> Json.arr(param.uri.get)
            )
          )
        case _ => "{}"
      }

      val computingUnit = new WorkflowComputingUnit()
      val userToken = JwtAuth.jwtToken(jwtClaims(user.user))
      computingUnit.setUid(user.getUid)
      computingUnit.setName(param.name)
      computingUnit.setCreationTime(new Timestamp(System.currentTimeMillis()))
      computingUnit.setType(WorkflowComputingUnitTypeEnum.lookupLiteral(param.unitType))
      computingUnit.setResource(resourceJson)

      // Set URI during initial insert for local only
      if (cuType == WorkflowComputingUnitTypeEnum.local) {
        computingUnit.setUri(param.uri.get)
      } else {
        computingUnit.setUri("") // placeholder for kubernetes
      }

      wcDao.insert(computingUnit)

      val userDao = new UserDao(ctx.configuration())
      val ownerUser = Option(userDao.fetchOneByUid(user.getUid))
      val ownerAvatar: String =
        ownerUser.flatMap(u => Option(u.getAvatar).filter(_.nonEmpty)).orNull
      val ownerUsername: String =
        ownerUser.flatMap(u => Option(u.getName).filter(_.nonEmpty)).orNull

      // Retrieve generated cuid
      val cuid = ctx.lastID().intValue()
      val insertedUnit = wcDao.fetchOneByCuid(cuid)

      // A pod outlives the transaction that created it, so anything throwing after it
      // exists has to take it back down. Without this, a failure between pod creation
      // and the end of the transaction rolled the row back and left the pod running
      // with nothing referencing it: one was observed crash-looping for eight hours,
      // invisible to Texera, reapable only by hand.
      var createdPodCuid: Option[Int] = None
      try {
        if (cuType == WorkflowComputingUnitTypeEnum.kubernetes && insertedUnit != null) {
          // 1. Update the DB with the URI
          insertedUnit.setUri(KubernetesClient.generatePodURI(cuid))

          val updatedResource: JsObject =
            Json
              .parse(insertedUnit.getResource)
              .as[JsObject] ++
              Json.obj("nodeAddresses" -> Json.arr(insertedUnit.getUri))

          insertedUnit.setResource(Json.stringify(updatedResource))
          wcDao.update(insertedUnit)

          // 2. Launch the pod as CU
          try {
            KubernetesClient.createPod(
              cuid,
              param.cpuLimit,
              param.memoryLimit,
              param.gpuLimit,
              computingUnitEnvironmentVariables ++ Map(
                EnvironmentalVariable.ENV_USER_JWT_TOKEN -> userToken,
                EnvironmentalVariable.ENV_JAVA_OPTS -> s"-Xmx${param.jvmMemorySize}"
              ),
              Some(param.shmSize),
              curatedImage
            )
            createdPodCuid = Some(cuid)
          } catch {
            case e: KubernetesClientException =>
              throw ComputingUnitManagingServiceException.fromKubernetes(e)
          }
        }

        DashboardWorkflowComputingUnit(
          insertedUnit,
          ComputingUnitHelpers.getComputingUnitStatus(insertedUnit).toString,
          ComputingUnitHelpers.getComputingUnitMetrics(insertedUnit),
          isOwner = true,
          accessPrivilege = PrivilegeEnum.WRITE,
          ownerAvatar,
          ownerUsername
        )
      } catch {
        case t: Throwable =>
          createdPodCuid.foreach { orphanCuid =>
            try KubernetesClient.deletePod(orphanCuid)
            catch {
              // Reported rather than rethrown: the original failure is what the caller
              // needs to see, and shadowing it with a cleanup error would lose it.
              case cleanupError: Throwable =>
                logger.error(
                  s"Computing unit $orphanCuid failed to be created and its pod could " +
                    "not be removed; it may need deleting by hand.",
                  cleanupError
                )
            }
          }
          throw t
      }
    }
  }

  /**
    * List all computing units created by the current user.
    *
    * @return A list of computing units that are not terminated.
    */
  @GET
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Consumes(Array(MediaType.APPLICATION_JSON))
  @Produces(Array(MediaType.APPLICATION_JSON))
  @Path("")
  def listComputingUnits(
      @Auth user: SessionUser
  ): List[DashboardWorkflowComputingUnit] = {
    withTransaction(context) { ctx =>
      val computingUnitDao = new WorkflowComputingUnitDao(ctx.configuration())
      val uid = user.getUid

      // Always fetch units owned by the user
      val ownedUnits = computingUnitDao.fetchByUid(uid).asScala.toList

      // Conditionally fetch shared units based on the config flag
      val (sharedUnits, sharedUnitInfo) =
        if (ComputingUnitConfig.sharingComputingUnitEnabled) {
          val computingUnitUserAccessDao = new ComputingUnitUserAccessDao(ctx.configuration())
          val info = computingUnitUserAccessDao
            .fetchByUid(uid)
            .asScala
            .map(access => access.getCuid -> access.getPrivilege)
            .toMap
          val sharedCuids = info.keys.toList.map(Integer.valueOf(_))

          val units = if (sharedCuids.isEmpty) {
            List()
          } else {
            computingUnitDao.fetchByCuid(sharedCuids: _*).asScala.toList
          }
          (units, info)
        } else {
          // If sharing is disabled, return empty collections
          (List.empty[WorkflowComputingUnit], Map.empty[Integer, PrivilegeEnum])
        }

      val userDao = new UserDao(ctx.configuration())

      // Pair each unit with the caller's privilege (owned default to WRITE), one row per cuid, so
      // a unit that is both owned and shared is reconciled/rendered exactly once.
      val unitsWithPrivilege =
        (ownedUnits.map(u => (u, PrivilegeEnum.WRITE)) ++
          sharedUnits.map(u => (u, sharedUnitInfo(u.getCuid))))
          .distinctBy { case (unit, _) => unit.getCuid }
          .filter { case (unit, _) => unit.getTerminateTime == null }
      val privilegeByCuid = unitsWithPrivilege.map {
        case (unit, privilege) => unit.getCuid -> privilege
      }.toMap
      val candidateUnits = unitsWithPrivilege.map { case (unit, _) => unit }

      // Pod phases decide which Kubernetes units are still alive.
      val podPhases = ComputingUnitHelpers.podPhasesFor(candidateUnits)

      val liveUnits =
        ComputingUnitHelpers.reconcileVanishedKubernetesUnits(
          computingUnitDao,
          candidateUnits,
          podPhases
        )

      // Metrics only for survivors, so fetch after reconciliation.
      val podMetrics = ComputingUnitHelpers.podMetricsFor(liveUnits)

      val ownerInfoMap =
        ComputingUnitHelpers.resolveOwnerInfo(userDao, liveUnits.map(_.getUid).distinct)

      liveUnits.map { unit =>
        ComputingUnitHelpers.buildDashboardUnit(
          unit,
          isOwner = unit.getUid.equals(uid),
          accessPrivilege = privilegeByCuid(unit.getCuid),
          ownerInfo = ownerInfoMap,
          podPhases = podPhases,
          podMetrics = podMetrics
        )
      }
    }
  }

  /**
    * Return a fully populated [[org.apache.texera.service.resource.ComputingUnitManagingResource.DashboardWorkflowComputingUnit]] for the
    * specified `cuid`, identical to one row produced by /list.
    *
    * @param cuid the ID of the computing-unit to fetch
    */
  @GET
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Produces(Array(MediaType.APPLICATION_JSON))
  @Path("/{cuid}")
  def getComputingUnitInfo(
      @PathParam("cuid") cuid: Integer,
      @Auth user: SessionUser
  ): DashboardWorkflowComputingUnit = {

    val unit = getComputingUnitByCuid(context, cuid)
    val userDao = new UserDao(context.configuration())
    val ownerUser = Option(userDao.fetchOneByUid(unit.getUid))
    val ownerAvatar: String =
      ownerUser.flatMap(u => Option(u.getAvatar).filter(_.nonEmpty)).orNull
    val ownerUsername: String =
      ownerUser.flatMap(u => Option(u.getName).filter(_.nonEmpty)).orNull

    DashboardWorkflowComputingUnit(
      computingUnit = unit,
      status = ComputingUnitHelpers.getComputingUnitStatus(unit).toString,
      metrics = ComputingUnitHelpers.getComputingUnitMetrics(unit),
      isOwner = unit.getUid.equals(user.getUid),
      accessPrivilege = {
        val cuAccessDao = new ComputingUnitUserAccessDao(context.configuration())
        val access = cuAccessDao
          .fetchByUid(user.getUid)
          .asScala
          .find(access => access.getCuid.equals(cuid))

        if (access.isDefined) {
          access.get.getPrivilege
        } else if (unit.getUid.equals(user.getUid)) {
          PrivilegeEnum.WRITE
        } else {
          // Default privilege for non-owners without explicit access
          PrivilegeEnum.NONE
        }
      },
      ownerAvatar,
      ownerUsername
    )
  }

  /**
    * Terminate the computing unit's pod based on the pod URI.
    *
    * @return A response indicating success or failure.
    */
  @DELETE
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Consumes(Array(MediaType.APPLICATION_JSON))
  @Produces(Array(MediaType.APPLICATION_JSON))
  @Path("/{cuid}/terminate")
  def terminateComputingUnit(
      @PathParam("cuid") cuid: Integer,
      @Auth user: SessionUser
  ): Response = {
    // ADMINs may terminate any unit; everyone else must own it.
    if (!user.isRoleOf(UserRoleEnum.ADMIN) && !userOwnComputingUnit(context, cuid, user.getUid)) {
      return Response
        .status(Response.Status.BAD_REQUEST)
        .entity(s"User has no access to the computing unit")
        .build()
    }

    // If successful, update the database
    withTransaction(context) { ctx =>
      val cuDao = new WorkflowComputingUnitDao(ctx.configuration())
      val unit = getComputingUnitByCuid(ctx, cuid)

      // if the computing unit is kubernetes pod, then kill the pod
      if (unit.getType == WorkflowComputingUnitTypeEnum.kubernetes) {
        KubernetesClient.deletePod(cuid)
      }

      unit.setTerminateTime(new Timestamp(System.currentTimeMillis()))
      cuDao.update(unit)
    }
    Response.ok().build()
  }

  /**
    * Rename a computing unit.
    *
    * @param cuid The computing unit ID.
    * @param name The new name for the computing unit.
    * @param user The authenticated user.
    * @return A response indicating success or failure.
    */
  @PUT
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Consumes(Array(MediaType.APPLICATION_JSON))
  @Produces(Array(MediaType.APPLICATION_JSON))
  @Path("/{cuid}/rename/{name}")
  def renameComputingUnit(
      @PathParam("cuid") cuid: Integer,
      @PathParam("name") name: String,
      @Auth user: SessionUser
  ): Response = {
    // Verify ownership or write access
    if (
      !userOwnComputingUnit(context, cuid, user.getUid) &&
      !ComputingUnitAccessResource.hasWriteAccess(cuid, user.getUid)
    ) {
      return Response
        .status(Response.Status.FORBIDDEN)
        .entity("User does not have permission to rename this computing unit")
        .build()
    }

    // Validate name
    if (StringUtils.isBlank(name)) {
      return Response
        .status(Response.Status.BAD_REQUEST)
        .entity("Computing unit name cannot be empty or blank")
        .build()
    }

    withTransaction(context) { ctx =>
      val cuDao = new WorkflowComputingUnitDao(ctx.configuration())
      val unit = getComputingUnitByCuid(ctx, cuid)

      try {
        unit.setName(name)
        cuDao.update(unit)
      } catch {
        case e: Exception =>
          return Response
            .status(Response.Status.INTERNAL_SERVER_ERROR)
            .entity(e.getMessage)
            .build()
      }
    }

    Response.ok().build()
  }

  /**
    * Retrieves the CPU and memory metrics for a computing unit identified by its `cuid`.
    *
    * @param cuid The computing unit ID.
    * @return A `WorkflowComputingUnitMetrics` object with CPU and memory usage data.
    */
  @GET
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Produces(Array(MediaType.APPLICATION_JSON))
  @Path("/{cuid}/metrics")
  def getComputingUnitMetricsEndpoint(
      @PathParam("cuid") cuid: String,
      @Auth user: SessionUser
  ): WorkflowComputingUnitMetrics = {
    if (!userOwnComputingUnit(context, cuid.toInt, user.getUid)) {
      throw new BadRequestException("User has no access to the computing unit")
    }
    val computingUnit = getComputingUnitByCuid(context, cuid.toInt)
    ComputingUnitHelpers.getComputingUnitMetrics(computingUnit)
  }

  @GET
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Produces(Array(MediaType.APPLICATION_JSON))
  @Path("/{cuid}/limits")
  def getComputingUnitResourceLimit(
      @PathParam("cuid") cuid: String,
      @Auth user: SessionUser
  ): WorkflowComputingUnitResourceLimit = {
    if (!userOwnComputingUnit(context, cuid.toInt, user.getUid)) {
      throw new BadRequestException("User has no access to the computing unit")
    }
    val computingUnit = getComputingUnitByCuid(context, cuid.toInt)
    getComputingUnitResourceLimit(computingUnit)
  }

  // -- Model mounts --------------------------------------------------------
  // A model version is FUSE-mounted into a computing unit by that unit's node mounter, a
  // privileged per-node DaemonSet, so the user-facing CU pod never needs privileges. This
  // service is the authenticated proxy in front of that mounter. Mount state lives only on
  // the mounter, derived from the kernel's mount table, so there is nothing to persist.

  private def requireMountAccess(cuid: Int, uid: Integer): Unit = {
    if (
      !userOwnComputingUnit(context, cuid, uid) &&
      !ComputingUnitAccessResource.hasWriteAccess(cuid, uid)
    ) {
      throw new ForbiddenException(
        "User does not have permission to manage mounts on this computing unit"
      )
    }
  }

  private def requireKubernetesUnit(cuid: Int): Unit = {
    if (getComputingUnitByCuid(context, cuid).getType != WorkflowComputingUnitTypeEnum.kubernetes) {
      throw new BadRequestException(
        "Model mounting is only supported for Kubernetes computing units."
      )
    }
  }

  /** Node IP the CU pod is scheduled on, needed to reach that node's mounter. */
  private def mountNodeIp(cuid: Int): String = {
    KubernetesClient
      .getPodByName(KubernetesClient.generatePodName(cuid))
      .flatMap(pod => Option(pod.getStatus).flatMap(status => Option(status.getHostIP)))
      .getOrElse(
        throw new BadRequestException(
          s"Computing unit $cuid is not running on a node yet; cannot manage mounts."
        )
      )
  }

  /**
    * Turns "the node mounter did not answer" into something actionable.
    *
    * The mounter is a DaemonSet, so it is reachable only on a cluster where it is actually
    * deployed. Letting the raw ConnectException out produced a bare 500 -- "There was an
    * error processing your request" -- which says nothing about which address failed or
    * that the DaemonSet may simply be absent. Not reported as empty either: an unreachable
    * mounter means the mounts are unknown, not that there are none.
    */
  private def withMounter[T](nodeIp: String)(operation: => T): T =
    try operation
    catch {
      case e: java.io.IOException =>
        throw new ServiceUnavailableException(
          s"The node mounter at $nodeIp:${KubernetesConfig.mounterPort} did not answer " +
            s"(${e.getClass.getSimpleName}: ${e.getMessage}). Model mounting needs the " +
            "texera-mounter DaemonSet running on that node."
        )
      // The mounter answered and said it failed. Its message names the real cause -- a
      // GeeseFS error, a bucket that does not exist -- and is the only thing that makes
      // this diagnosable, so it is passed on rather than swallowed into a generic 500.
      case e: MounterRequestFailed =>
        throw new ServiceUnavailableException(
          s"The node mounter could not complete the operation: ${e.getMessage}"
        )
    }

  private def resolveMountModelPath(modelPath: String): (String, (String, String)) = {
    val trimmed = Option(modelPath).map(_.trim).getOrElse("")
    if (trimmed.isEmpty) {
      throw new BadRequestException("modelPath is required")
    }
    // FileResolver signals both "no such model version" and "that is not a model version
    // path" as FileNotFoundException, which dropwizard would turn into a bare 500 saying
    // only that the request was logged. Both are the caller's mistake and both messages
    // already say which, so they are worth passing on.
    val resolved =
      try FileResolver.resolveModelVersion(trimmed)
      catch {
        case e: org.apache.commons.vfs2.FileNotFoundException =>
          throw new BadRequestException(Option(e.getMessage).getOrElse(s"Unknown model $trimmed."))
      }
    (trimmed, resolved)
  }

  /** The models currently mounted on the given computing unit. */
  @GET
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Produces(Array(MediaType.APPLICATION_JSON))
  @Path("/{cuid}/mounts")
  def listMountedModels(
      @PathParam("cuid") cuid: Integer,
      @Auth user: SessionUser
  ): List[MountedModelInfo] = {
    requireMountAccess(cuid, user.getUid)
    // A local unit has no node mounter, and asking for its mounts is a reasonable thing
    // for a general-purpose UI to do, so this is empty rather than an error.
    if (getComputingUnitByCuid(context, cuid).getType != WorkflowComputingUnitTypeEnum.kubernetes) {
      return List.empty
    }
    val nodeIp = mountNodeIp(cuid)
    withMounter(nodeIp) {
      MounterClient.listMounts(nodeIp, KubernetesConfig.mounterPort, cuid.toString)
    }.map { entry =>
      val modelPath =
        FileResolver
          .reverseResolveModelVersion(entry.repositoryName, entry.commitHash)
          .getOrElse("")
      MountedModelInfo(modelPath, entry.repositoryName, entry.commitHash, entry.mountPath)
    }
  }

  /** Mounts a model version onto the given computing unit. */
  @POST
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Consumes(Array(MediaType.APPLICATION_JSON))
  @Produces(Array(MediaType.APPLICATION_JSON))
  @Path("/{cuid}/mounts")
  def mountModel(
      @PathParam("cuid") cuid: Integer,
      params: ModelMountParams,
      @Auth user: SessionUser
  ): MountedModelInfo = {
    requireMountAccess(cuid, user.getUid)
    requireKubernetesUnit(cuid)
    val (modelPath, (repositoryName, commitHash)) = resolveMountModelPath(params.modelPath)
    val nodeIp = mountNodeIp(cuid)
    // A token for the requesting user, forwarded to GeeseFS as its S3 access key;
    // file-service verifies it and checks that user's read access to the model. No global
    // LakeFS credential is handed to the mounter or to the pod.
    val userToken = JwtAuth.jwtToken(jwtClaims(user.user))
    val mountPath = withMounter(nodeIp) {
      MounterClient.mount(
        nodeIp,
        KubernetesConfig.mounterPort,
        cuid.toString,
        repositoryName,
        commitHash,
        userToken,
        fileServiceBaseUrl
      )
    }
    MountedModelInfo(modelPath, repositoryName, commitHash, mountPath)
  }

  /** Unmounts a model version from the given computing unit. */
  @DELETE
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  @Consumes(Array(MediaType.APPLICATION_JSON))
  @Produces(Array(MediaType.APPLICATION_JSON))
  @Path("/{cuid}/mounts")
  def unmountModel(
      @PathParam("cuid") cuid: Integer,
      params: ModelMountParams,
      @Auth user: SessionUser
  ): Response = {
    requireMountAccess(cuid, user.getUid)
    requireKubernetesUnit(cuid)
    val (_, (repositoryName, commitHash)) = resolveMountModelPath(params.modelPath)
    val nodeIp = mountNodeIp(cuid)
    withMounter(nodeIp) {
      MounterClient.unmount(
        nodeIp,
        KubernetesConfig.mounterPort,
        cuid.toString,
        repositoryName,
        commitHash
      )
    }
    Response.ok().build()
  }
}
