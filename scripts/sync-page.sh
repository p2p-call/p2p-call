#!/bin/sh
# The guests' call page on the permanent link's site (docs/c1/) is a copy of
# the one the program serves to the organizer (call/web/). Run this after
# changing call/web/; a test (TestSitePageIsCurrent) fails if it was forgotten.
set -eu
cd "$(dirname "$0")/.."
rm -rf docs/c1
mkdir -p docs/c1
cp call/web/* docs/c1/
