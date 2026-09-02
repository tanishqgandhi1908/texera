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

# A sample computing-unit image for testing Texera's curated-image feature.
#
# The FROM line is the part that matters. A computing unit runs the image's own CMD,
# which must be bin/computing-unit-master -- the Amber engine. Building on the Texera
# image is what makes validation accept this; an arbitrary image is rejected.
#
# WHAT MAKES THIS A TEST RATHER THAN A TAUTOLOGY:
# The stock image already ships scikit-learn, torch and transformers, so adding
# scikit-learn alone proves nothing -- the control workflow would succeed on the stock
# image too. xgboost is genuinely absent, so a UDF importing it fails on the stock image
# and works here. That difference is the evidence that image selection is load-bearing.
#
# scikit-learn is also pinned DOWN (1.5.2, against the stock 1.7.2) as a second signal:
# the version the workflow prints tells you which image actually ran.
FROM ghcr.io/apache/texera-workflow-execution-coordinator:latest

USER root

RUN pip3 install --no-cache-dir \
      "xgboost==2.1.1" \
      "scikit-learn==1.5.2" \
      "joblib==1.4.2"

# Fail the build here rather than surfacing an ImportError inside a workflow later.
RUN python3 -c "\
import xgboost, sklearn, joblib, pyarrow, pandas, numpy; \
print('xgboost', xgboost.__version__); \
print('sklearn', sklearn.__version__); \
print('joblib', joblib.__version__); \
print('pandas', pandas.__version__, 'numpy', numpy.__version__)"

USER texera
