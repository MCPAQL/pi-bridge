#!/usr/bin/env bash
# Run the test suite against multiple Node majors in isolated containers.
#
# Usage:
#   bash scripts/test-matrix.sh           # defaults to 20 22 24
#   bash scripts/test-matrix.sh 20 22     # explicit versions
#
# Each version gets its own image tag (mcpaql-pi-bridge-test:n<version>),
# so layer caching kicks in on rebuilds.

set -euo pipefail

if [ $# -eq 0 ]; then
	versions=(20 22 24)
else
	versions=("$@")
fi

failed=()

for v in "${versions[@]}"; do
	echo
	echo "=== Node ${v} ==="
	if ! docker build --build-arg NODE_VERSION="${v}" -t "mcpaql-pi-bridge-test:n${v}" .; then
		failed+=("build:n${v}")
		continue
	fi
	if ! docker run --rm "mcpaql-pi-bridge-test:n${v}"; then
		failed+=("test:n${v}")
	fi
done

if [ ${#failed[@]} -ne 0 ]; then
	echo
	echo "FAILED: ${failed[*]}"
	exit 1
fi

echo
echo "OK across Node: ${versions[*]}"
