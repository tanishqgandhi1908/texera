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

# Paste into a "Python UDF" operator. Proves the computing unit is running the curated
# image: sklearn is not in Texera's default image, so this fails there and works here.
#
# Trains a tiny classifier and emits one row per prediction, so the result table itself
# is the evidence -- not just an import that happened to succeed.
from pytexera import *
import sklearn
from sklearn.ensemble import RandomForestClassifier
from sklearn.datasets import load_iris


class ProcessTupleOperator(UDFOperatorV2):

    @overrides
    def open(self):
        # Fit once per worker rather than per tuple.
        data = load_iris()
        self.model = RandomForestClassifier(n_estimators=10, random_state=0)
        self.model.fit(data.data, data.target)
        self.target_names = data.target_names
        self.samples = data.data[:5]

    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        for i, features in enumerate(self.samples):
            predicted = self.model.predict([features])[0]
            yield {
                "sample": i,
                "sklearn_version": sklearn.__version__,
                "predicted_species": str(self.target_names[predicted]),
                "confidence": float(self.model.predict_proba([features])[0][predicted]),
            }
