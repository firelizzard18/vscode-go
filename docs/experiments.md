# Experiments

Preview versions of vscode-go include experimental features. These features may
be individually enabled or disabled via the setting `go.experiments`.

## Test explorer

The [exp-vscode-go](TODO: add link) extension includes an experimental test
explorer implementation based on `gopls`. If exp-vscode-go is present and
vscode-go is a preview version, vscode-go will prefer exp-vscode-go's test
explorer, disabling its own, unless the experiment is disabled. The experimental
test explorer provides more robust test discovery by using gopls, including
static discovery of _some_ subtests. It also implements the following features:

- Ignore tests within files excluded by `files.exclude` or
  `goExp.testExplorer.exclude`.
- Disable automatic discovery of tests by setting `goExp.testExplorer.discovery`
  to "off".
- Control how tests are displayed with `goExp.testExplorer.showFiles`,
  `goExp.testExplorer.nestPackages`, and `goExp.testExplorer.nestSubtests`.
- Debugging a test updates its status in the test explorer.
- Support for continuous runs.
- Code lenses (hidden by default) that are integrated with the test explorer.