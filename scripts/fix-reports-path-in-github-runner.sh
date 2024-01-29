#!/bin/bash
# Path variables
defaultPrefixToReplace="/github/workspace"
defaultAbsolutePathPrefix="home/runner/work/rudder-sdk-node/rudder-sdk-node"
selfHostedAbsolutePathPrefix="runner/_work/rudder-sdk-node/rudder-sdk-node"
absolutePathPrefix="$defaultAbsolutePathPrefix"

# List of files to alter
echo "Replacing $absolutePathPrefix for reports"
sed -i "s+$absolutePathPrefix+$defaultPrefixToReplace+g" "coverage/lcov.info"
# For relative paths in lcov.info
sed -i "s+SF:$absolutePathPrefix/+SF:+g" "coverage/lcov.info"
sed -i "s+/$absolutePathPrefix+$defaultPrefixToReplace+g" "reports/eslint.json"
