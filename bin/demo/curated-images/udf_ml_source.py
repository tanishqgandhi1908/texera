# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Paste into a **Python UDF Source** operator. No input operator is needed, so the whole
# test is one operator on the canvas.
#
# On the CURATED image -> five rows: xgboost 2.1.1, sklearn 1.5.2, predictions.
# On the STOCK image   -> ModuleNotFoundError: No module named 'xgboost'
#
# That failure is the point: it is what proves the computing unit really started from the
# selected image. See udf_ml_transform.py for the transform variant.
from pytexera import *

import xgboost
import sklearn
from sklearn.datasets import load_iris
from xgboost import XGBClassifier


class GenerateOperator(UDFSourceOperator):

    @overrides
    def produce(self) -> Iterator[Union[TupleLike, TableLike, None]]:
        data = load_iris()
        model = XGBClassifier(
            n_estimators=10, max_depth=3, random_state=0, verbosity=0
        )
        model.fit(data.data, data.target)

        for i, features in enumerate(data.data[:5]):
            proba = model.predict_proba([features])[0]
            predicted = int(proba.argmax())
            yield {
                "sample": i,
                "xgboost_version": xgboost.__version__,
                "sklearn_version": sklearn.__version__,
                "predicted_species": str(data.target_names[predicted]),
                "confidence": float(proba[predicted]),
            }
