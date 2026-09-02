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

"""Keep pytest out of the demo tree.

CI runs `pytest bin/` to pick up tests anywhere under bin/, and pytest collects both
`test_*.py` and `*_test.py`. Files here are UDF bodies and scripts meant to be pasted
into an operator or run by hand -- they import pytexera and expect an operator runtime,
so collecting one fails the whole run at import time rather than reporting a test result.

Naming a file around the pattern works until the next demo is added, so the whole
directory is excluded instead.
"""

collect_ignore_glob = ["*"]
