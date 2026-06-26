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

package org.apache.texera.amber.operator.machineLearning.modelInference

import com.fasterxml.jackson.annotation.{JsonProperty, JsonPropertyDescription}
import com.kjetland.jackson.jsonSchema.annotations.JsonSchemaTitle
import org.apache.texera.amber.core.tuple.{AttributeType, Schema}
import org.apache.texera.amber.core.workflow.{InputPort, OutputPort, PortIdentity}
import org.apache.texera.amber.operator.PythonOperatorDescriptor
import org.apache.texera.amber.operator.metadata.annotations.AutofillAttributeNameList
import org.apache.texera.amber.operator.metadata.{OperatorGroupConstants, OperatorInfo}
import org.apache.texera.amber.pybuilder.PyStringTypes.EncodableString
import org.apache.texera.amber.pybuilder.PythonTemplateBuilder.PythonTemplateBuilderStringContext

/**
  * Generic "use a pre-trained model" inference operator (Design B prototype).
  *
  * Modeled on HuggingFaceInferenceOpDesc: one data input, a model selector, an
  * input-column picker, and an output column. No user code. The selected model is
  * an uploaded asset (type = MODEL); its bytes are fetched in the Python worker via
  * pytexera's DatasetFileDocument and loaded with torch.jit.load (self-contained
  * TorchScript). Framework-agnostic by intent — PyTorch now, MLflow later.
  */
class ModelInferenceOpDesc extends PythonOperatorDescriptor {

  @JsonProperty(value = "modelPath", required = true)
  @JsonSchemaTitle("Model")
  @JsonPropertyDescription("Select an uploaded model (.pt) to run inference with")
  var modelPath: EncodableString = ""

  @JsonProperty(value = "featureColumns", required = true)
  @JsonSchemaTitle("Feature Columns")
  @JsonPropertyDescription("Input columns fed to the model, in order")
  @AutofillAttributeNameList
  var featureColumns: List[EncodableString] = List()

  @JsonProperty(value = "outputColumn", required = false, defaultValue = "prediction")
  @JsonSchemaTitle("Output Column Name")
  @JsonPropertyDescription("Name of the new column holding the model's prediction")
  var outputColumn: EncodableString = "prediction"

  private def resolvedOutputColumn: EncodableString =
    if (outputColumn == null || outputColumn.trim.isEmpty) "prediction" else outputColumn

  override def generatePythonCode(): String = {
    val featureList = featureColumns.map(c => pyb"""$c""").mkString(", ")
    val outCol: EncodableString = resolvedOutputColumn
    pyb"""
       |from pytexera import *
       |from pytexera.storage import DatasetFileDocument
       |import torch
       |
       |class ProcessTupleOperator(UDFOperatorV2):
       |    @overrides
       |    def open(self):
       |        buf = DatasetFileDocument($modelPath).read_file()
       |        self.model = torch.jit.load(buf)
       |        self.model.eval()
       |
       |    @overrides
       |    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
       |        feature_cols = [$featureList]
       |        features = [float(tuple_[c]) for c in feature_cols]
       |        x = torch.tensor([features], dtype=torch.float32)
       |        with torch.no_grad():
       |            out = self.model(x)
       |        if out.ndim == 2 and out.shape[1] > 1:
       |            pred = int(out.argmax(1).item())
       |        else:
       |            pred = float(out.reshape(-1)[0].item())
       |        tuple_[$outCol] = str(pred)
       |        yield tuple_
       |""".encode
  }

  override def operatorInfo: OperatorInfo =
    OperatorInfo(
      "Model Inference",
      "Run a pre-trained model (e.g. PyTorch) on the input columns and append its prediction",
      OperatorGroupConstants.MACHINE_LEARNING_GROUP,
      inputPorts = List(InputPort()),
      outputPorts = List(OutputPort())
    )

  override def getOutputSchemas(
      inputSchemas: Map[PortIdentity, Schema]
  ): Map[PortIdentity, Schema] =
    Map(
      operatorInfo.outputPorts.head.id -> inputSchemas.values.head
        .add(resolvedOutputColumn, AttributeType.STRING)
    )
}
