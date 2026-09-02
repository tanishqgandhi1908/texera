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

# Paste into a **Python UDF** (transform) operator. This one needs an upstream operator --
# any source with at least one row will do, since the code ignores the input and emits its
# own rows. Use udf_ml_source.py if you would rather have a single self-contained operator.
#
# On the CURATED image -> five rows: xgboost 2.1.1, sklearn 1.5.2, predictions.
# On the STOCK image   -> ModuleNotFoundError: No module named 'xgboost'
from pytexera import *

import xgboost
import sklearn
from sklearn.datasets import load_iris
from xgboost import XGBClassifier


class ProcessTupleOperator(UDFOperatorV2):

    @overrides
    def open(self):
        data = load_iris()
        self.model = XGBClassifier(
            n_estimators=10, max_depth=3, random_state=0, verbosity=0
        )
        self.model.fit(data.data, data.target)
        self.target_names = data.target_names
        self.samples = data.data[:5]

    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        for i, features in enumerate(self.samples):
            proba = self.model.predict_proba([features])[0]
            predicted = int(proba.argmax())
            yield {
                "sample": i,
                "xgboost_version": xgboost.__version__,
                "sklearn_version": sklearn.__version__,
                "predicted_species": str(self.target_names[predicted]),
                "confidence": float(proba[predicted]),
            }
