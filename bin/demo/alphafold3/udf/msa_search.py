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

# The AlphaFold 3 half of the demo: one operator, running AF3's own MSA search.
#
# This is the real thing -- alphafold3.data.tools.jackhmmer is the class AF3's
# data pipeline uses, and it shells out to the real jackhmmer binary. It is also
# precisely what a Python virtual environment could not have delivered:
#
#   * AF3 needs Python >= 3.12; the stock engine image has 3.10, and a venv is
#     built from the image's interpreter, so no PVE can change the version.
#   * AF3 is not on PyPI and compiles a C++ extension; a PVE installs pip
#     packages and has no build step.
#   * jackhmmer is an executable, not a Python package, so no venv can hold it.
#
# All three are settled in the image (bin/dockerfiles/computing-unit-alphafold3.dockerfile).
# The operator just picks the environment by name and imports.
#
# Paste into a "Python UDF" operator; set "Default Python Environment" to false
# and "Virtual Environment" to alphafold3.

from pytexera import *

import os
import shutil
import sys
import time
from importlib.metadata import version


class ProcessTupleOperator(UDFOperatorV2):

    @overrides
    def open(self):
        from alphafold3.data.tools import jackhmmer

        # The model version holding the sequence database is mounted read-only,
        # and this is the directory it landed in. Nothing was copied to get here.
        seq_db_dir = self.UiParameter(
            "SEQ_DB", AttributeType.STRING, value=Resource.MODEL
        ).value

        database_path = os.path.join(seq_db_dir, "ubiquitin_family.fasta")
        if not os.path.exists(database_path):
            raise FileNotFoundError(
                f"No ubiquitin_family.fasta under the mounted model at {seq_db_dir}. "
                f"Found instead: {sorted(os.listdir(seq_db_dir))}"
            )

        self.jackhmmer_path = shutil.which("jackhmmer")
        if not self.jackhmmer_path:
            raise RuntimeError(
                "jackhmmer is not on PATH -- this operator is running on the stock "
                "engine image rather than the AlphaFold 3 one."
            )

        # n_iter=1 keeps the demo quick; AF3's own default is 3 iterations.
        self.searcher = jackhmmer.Jackhmmer(
            binary_path=self.jackhmmer_path,
            database_path=database_path,
            n_cpu=2,
            n_iter=1,
            max_sequences=500,
        )

        self.af3_version = version("alphafold3")
        self.python_version = ".".join(str(part) for part in sys.version_info[:3])

    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        sequence = tuple_["sequence"]

        started = time.time()
        result = self.searcher.query(sequence)
        elapsed = time.time() - started

        # An a3m holds one FASTA-style header per aligned sequence, the query
        # included, so the header count is the depth of the alignment.
        alignment = result.a3m
        msa_depth = alignment.count(">")

        yield {
            "protein": tuple_["protein"],
            "accession": tuple_["accession"],
            "residues": len(sequence),
            "msa_depth": msa_depth,
            "search_seconds": round(elapsed, 3),
            "alphafold3_version": self.af3_version,
            "python_version": self.python_version,
            "jackhmmer": self.jackhmmer_path,
        }
