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

# A computing-unit image that runs the Amber engine and carries AlphaFold 3.
#
# Why this exists rather than a Python virtual environment: a PVE is a list of pip
# packages installed into a venv built from the image's own interpreter, and AF3 fits
# none of that. It needs Python >= 3.12 where the engine image has 3.10; it is not on
# PyPI and builds a C++ extension from source; and its data pipeline shells out to
# jackhmmer and nhmmer, which are system binaries no venv can hold. Each of those is
# settled here, at build time, as root -- and, because it is an image, it is settled
# identically for every computing unit started from it and survives every restart.
#
# Build (context is this directory; nothing from the repository tree is needed):
#   docker build -f computing-unit-alphafold3.dockerfile \
#     --build-arg BASE_IMAGE=texera-local/texera-workflow-execution-coordinator:dev \
#     -t texera-local/computing-unit-alphafold3:dev .

ARG BASE_IMAGE=texera-local/texera-workflow-execution-coordinator:dev
FROM ${BASE_IMAGE}

USER root
ENV DEBIAN_FRONTEND=noninteractive

# hmmer is the reason a custom image is unavoidable: jackhmmer and nhmmer are
# executables, and the environment mechanism in the engine only installs Python
# packages. build-essential and zlib are for AF3's C++ extension; cmake and ninja
# come from PyPI via its build backend, so the distribution's older cmake is moot.
RUN apt-get update && apt-get install -y --no-install-recommends \
      hmmer \
      build-essential \
      zlib1g-dev \
      git \
      curl \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN jackhmmer -h > /dev/null && nhmmer -h > /dev/null && echo "hmmer OK"

# uv supplies a standalone CPython, so the base image staying on 3.10 does not
# constrain the environment. The install directory is deliberately outside root's
# home: the engine runs as the unprivileged `texera` user and has to execute it.
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python
ADD https://astral.sh/uv/install.sh /tmp/uv-install.sh
RUN sh /tmp/uv-install.sh \
    && mv /root/.local/bin/uv /usr/local/bin/uv \
    && mv /root/.local/bin/uvx /usr/local/bin/uvx \
    && uv --version

ARG PYTHON_VERSION=3.12
RUN uv python install ${PYTHON_VERSION}

# Where the entrypoint looks for environments to publish. The trailing `/pve` is
# not decoration: PveManager resolves <root>/<cuid>/<name>/pve/bin/python, so an
# environment is only found if it is laid out exactly that way.
ENV TEXERA_BAKED_ENV_ROOT=/opt/texera/python-envs
ENV AF3_ENV_NAME=alphafold3
ENV AF3_VENV=${TEXERA_BAKED_ENV_ROOT}/${AF3_ENV_NAME}/pve

RUN uv venv --python ${PYTHON_VERSION} ${AF3_VENV}

# The engine launches its Python worker with this interpreter, so the worker's own
# dependencies have to be here too -- an environment holding only AF3 would fail
# before any user code ran. requirements.txt is already in the base image, which is
# also where PveManager reads it from.
RUN uv pip install --python ${AF3_VENV}/bin/python --no-cache -r /tmp/requirements.txt

ARG AF3_REF=main
RUN git clone --depth 1 --branch ${AF3_REF} \
      https://github.com/google-deepmind/alphafold3.git /opt/alphafold3 \
    && git -C /opt/alphafold3 rev-parse HEAD > /opt/alphafold3-commit.txt \
    && cat /opt/alphafold3-commit.txt

# --no-deps keeps out `jax[cuda12]`: roughly 3 GB of NVIDIA wheels that a cluster
# without an NVIDIA GPU cannot use. The C++ extension is still compiled. AF3's own
# dependencies follow, with plain CPU jax substituted for the CUDA build.
RUN cd /opt/alphafold3 && uv pip install --python ${AF3_VENV}/bin/python --no-cache --no-deps .

RUN uv pip install --python ${AF3_VENV}/bin/python --no-cache \
      "absl-py>=2.3.1" \
      "dm-haiku==0.0.17" \
      "etils[epath]" \
      "jax==0.10.2" \
      "rdkit==2025.9.4" \
      "tokamax==0.0.12" \
      "tqdm" \
      "zstandard"

# Fail the build rather than the workflow. Each import stands for one thing that
# could not have been arranged from a PVE.
RUN ${AF3_VENV}/bin/python -c "\
import sys, shutil, alphafold3, jax, pyarrow, numpy, pandas; \
from alphafold3.data.tools import jackhmmer; \
assert sys.version_info[:2] >= (3, 12), sys.version; \
assert shutil.which('jackhmmer'), 'jackhmmer not on PATH'; \
print('python', sys.version.split()[0]); \
print('alphafold3', alphafold3.__file__); \
print('jax', jax.__version__, 'numpy', numpy.__version__); \
print('pyarrow', pyarrow.__version__, 'pandas', pandas.__version__); \
print('jackhmmer', shutil.which('jackhmmer'))"

COPY alphafold3-entrypoint.sh /usr/local/bin/texera-baked-env-entrypoint.sh
RUN chmod 0755 /usr/local/bin/texera-baked-env-entrypoint.sh

# The engine runs unprivileged, so everything it reads has to be readable by it.
RUN chmod -R a+rX /opt/texera /opt/uv-python /opt/alphafold3

USER texera

ENTRYPOINT ["/usr/local/bin/texera-baked-env-entrypoint.sh"]
CMD ["bin/computing-unit-master"]
