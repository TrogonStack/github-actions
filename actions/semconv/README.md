# semconv

Actions that enforce [Conventional Commits][spec] across a repository.

Every action in this family shares one grammar implementation,
[`lib/conventional.sh`](lib/conventional.sh), so a type accepted in one place
cannot be rejected in another.

| Action | Enforces |
| --- | --- |
| [`pull-request`](pull-request) | The pull request title and its commit subjects |

[spec]: https://www.conventionalcommits.org/en/v1.0.0/
