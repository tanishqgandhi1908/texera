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

package org.apache.texera.web.resource.dashboard.hub

import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

class EntityTablesSpec extends AnyFlatSpec with Matchers {

  // -- BaseEntityTable --------------------------------------------------------

  "EntityTables.BaseEntityTable.apply" should "dispatch Workflow → WorkflowTable" in {
    EntityTables.BaseEntityTable(EntityType.Workflow) shouldBe
      EntityTables.BaseEntityTable.WorkflowTable
  }

  it should "dispatch Dataset → DatasetTable" in {
    EntityTables.BaseEntityTable(EntityType.Dataset) shouldBe
      EntityTables.BaseEntityTable.DatasetTable
  }

  "BaseEntityTable.WorkflowTable" should "wire up id and isPublic columns from WORKFLOW" in {
    val t = EntityTables.BaseEntityTable.WorkflowTable
    t.idColumn.getName shouldBe "wid"
    t.isPublicColumn.getName shouldBe "is_public"
  }

  it should "dispatch Model → ModelTable" in {
    EntityTables.BaseEntityTable(EntityType.Model) shouldBe
      EntityTables.BaseEntityTable.ModelTable
  }

  "BaseEntityTable.DatasetTable" should "wire up id and isPublic columns from DATASET" in {
    val t = EntityTables.BaseEntityTable.DatasetTable
    t.idColumn.getName shouldBe "did"
    t.isPublicColumn.getName shouldBe "is_public"
  }

  "BaseEntityTable.ModelTable" should "wire up id and isPublic columns from MODEL" in {
    val t = EntityTables.BaseEntityTable.ModelTable
    t.idColumn.getName shouldBe "mid"
    t.isPublicColumn.getName shouldBe "is_public"
  }

  // -- LikeTable --------------------------------------------------------------

  "EntityTables.LikeTable.apply" should "dispatch Workflow → WorkflowLikeTable" in {
    EntityTables.LikeTable(EntityType.Workflow) shouldBe
      EntityTables.LikeTable.WorkflowLikeTable
  }

  it should "dispatch Dataset → DatasetLikeTable" in {
    EntityTables.LikeTable(EntityType.Dataset) shouldBe
      EntityTables.LikeTable.DatasetLikeTable
  }

  it should "dispatch Model → ModelLikeTable" in {
    EntityTables.LikeTable(EntityType.Model) shouldBe
      EntityTables.LikeTable.ModelLikeTable
  }

  "LikeTable variants" should "expose uid and the per-entity id column" in {
    val w = EntityTables.LikeTable.WorkflowLikeTable
    w.uidColumn.getName shouldBe "uid"
    w.idColumn.getName shouldBe "wid"

    val d = EntityTables.LikeTable.DatasetLikeTable
    d.uidColumn.getName shouldBe "uid"
    d.idColumn.getName shouldBe "did"

    val m = EntityTables.LikeTable.ModelLikeTable
    m.uidColumn.getName shouldBe "uid"
    m.idColumn.getName shouldBe "mid"
  }

  // -- CloneTable -------------------------------------------------------------

  "EntityTables.CloneTable.apply" should "dispatch Workflow → WorkflowCloneTable" in {
    EntityTables.CloneTable(EntityType.Workflow) shouldBe
      EntityTables.CloneTable.WorkflowCloneTable
  }

  it should "throw IllegalArgumentException for Dataset because there is no DatasetClone table" in {
    // The asymmetry is intentional today: dataset clones aren't a modelled
    // entity. Pinning the exception so a future addition of DatasetCloneTable
    // forces this spec to be updated alongside the new dispatch branch.
    val ex = intercept[IllegalArgumentException] {
      EntityTables.CloneTable(EntityType.Dataset)
    }
    ex.getMessage should include("Unsupported entity type")
    ex.getMessage should include("clone")
  }

  it should "throw IllegalArgumentException for Model because there is no ModelClone table" in {
    val ex = intercept[IllegalArgumentException] {
      EntityTables.CloneTable(EntityType.Model)
    }
    ex.getMessage should include("Unsupported entity type")
    ex.getMessage should include("clone")
  }

  "EntityTables.CloneTable.get" should "return the table for cloneable types and None otherwise" in {
    EntityTables.CloneTable.get(EntityType.Workflow) shouldBe
      Some(EntityTables.CloneTable.WorkflowCloneTable)
    EntityTables.CloneTable.get(EntityType.Dataset) shouldBe None
    EntityTables.CloneTable.get(EntityType.Model) shouldBe None
  }

  it should "be Some exactly for the types apply does not throw on" in {
    // Keeps get and apply from drifting apart when a new EntityType lands.
    EntityType.values.foreach { t =>
      val applySucceeds =
        try { EntityTables.CloneTable(t); true }
        catch { case _: IllegalArgumentException => false }
      EntityTables.CloneTable.get(t).isDefined shouldBe applySucceeds
    }
  }

  // -- ViewCountTable ---------------------------------------------------------

  "EntityTables.ViewCountTable.apply" should "dispatch Workflow → WorkflowViewCountTable" in {
    EntityTables.ViewCountTable(EntityType.Workflow) shouldBe
      EntityTables.ViewCountTable.WorkflowViewCountTable
  }

  it should "dispatch Dataset → DatasetViewCountTable" in {
    EntityTables.ViewCountTable(EntityType.Dataset) shouldBe
      EntityTables.ViewCountTable.DatasetViewCountTable
  }

  it should "dispatch Model → ModelViewCountTable" in {
    EntityTables.ViewCountTable(EntityType.Model) shouldBe
      EntityTables.ViewCountTable.ModelViewCountTable
  }

  "ViewCountTable variants" should "expose id and view_count columns" in {
    val w = EntityTables.ViewCountTable.WorkflowViewCountTable
    w.idColumn.getName shouldBe "wid"
    w.viewCountColumn.getName shouldBe "view_count"

    val d = EntityTables.ViewCountTable.DatasetViewCountTable
    d.idColumn.getName shouldBe "did"
    d.viewCountColumn.getName shouldBe "view_count"

    val m = EntityTables.ViewCountTable.ModelViewCountTable
    m.idColumn.getName shouldBe "mid"
    m.viewCountColumn.getName shouldBe "view_count"
  }
}
