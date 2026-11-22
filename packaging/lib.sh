#!/usr/bin/env bash
# Shared packaging helpers.

# select_rpm <dist-dir> <name> <version>
# Prints the newest RPM in <dist-dir> whose metadata says NAME == <name> and
# VERSION == <version>. Files that rpm cannot read are skipped with a warning on
# stderr. Returns 1 when nothing qualifies.
select_rpm() {
  local dist="$1" name="$2" want="$3" f meta
  local -a files
  mapfile -t files < <(find "$dist" -maxdepth 1 -name '*.rpm' -printf '%T@ %p\n' | sort -nr | cut -d' ' -f2-)
  for f in "${files[@]}"; do
    if ! meta="$(rpm -qp --qf '%{NAME} %{VERSION}' "$f" 2>/dev/null)"; then
      echo "warning: skipping unreadable rpm: $f" >&2
      continue
    fi
    if [[ "$meta" == "$name $want" ]]; then
      echo "$f"
      return 0
    fi
  done
  return 1
}
