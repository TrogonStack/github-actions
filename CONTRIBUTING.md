# Contributing

## Documentation placement

Keep the root README focused on the repository's purpose and general navigation.
Do not add action-specific announcements, usage instructions, or test commands
there. Document each action's usage and configuration in its own
`actions/<action>/README.md`. Put repository development and validation commands
in this guide.

## Validation

Run repository lint before submitting changes:

```sh
mise run github:actions:ci:lint
```

For coverage-report changes, run the publication and external-consumer regressions:

```sh
mise run github:actions:tests:coverage
```

The coverage tests require Python with `venv` and `ensurepip` support and a
repository filesystem that permits execution. On Debian or Ubuntu, install the
matching `python3-venv` package first.
