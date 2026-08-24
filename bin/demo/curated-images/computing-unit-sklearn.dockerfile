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
# computing-unit image inherits that, along with the Python worker and its deps.
# An image that does not (say, python:3.12) starts and immediately dies, so Texera
# rejects it before copying anything.
FROM ghcr.io/apache/texera-workflow-execution-coordinator:latest

# Install as root, then drop back. A computing unit that ran as root would be a
# privilege escalation -- and right now the pod does not enforce this, the image does.
USER root

# The point of a custom image: packages the default one does not have. These go into
# the engine's own interpreter, so a Python UDF can import them directly.
RUN pip3 install --no-cache-dir \
      "scikit-learn==1.5.2" \
      "joblib==1.4.2"

# Fail the build rather than the workflow. Without this an image missing a dependency
# only reveals it when a user's UDF raises ImportError mid-run.
RUN python3 -c "\
import sklearn, joblib, pyarrow, pandas, numpy; \
print('sklearn', sklearn.__version__); \
print('joblib', joblib.__version__); \
print('pandas', pandas.__version__, 'numpy', numpy.__version__)"

USER texera
