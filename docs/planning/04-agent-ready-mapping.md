# Agent-Ready Mapping

This document maps the current plan to the top-level `factory_compat` checks from `agent-ready`.

Planning notes:

- The current profile exposes 80 top-level checks.
- Nested alternatives under each top-level check are not listed individually here. The selected implementation path for each top-level check should satisfy one or more of those nested alternatives.
- Some items are planned for later phases or partly outside the repo. They are still tracked here because the Linear plan should represent the full control surface.

Status legend:

- `Phase 1`: should be satisfied during the core/base-plugin buildout
- `Later`: tracked in the roadmap, but not a first-wave implementation blocker
- `Later / External`: may depend on repo settings or deployment environment outside committed source files

## Documentation

- `docs.readme`: `Phase 1` via `CTL-01`
- `docs.readme_sections`: `Phase 1` via `CTL-01`
- `docs.contributing`: `Phase 1` via `CTL-01`
- `docs.agents_md`: `Phase 1` via `CTL-01`
- `docs.changelog`: `Phase 1` via `FND-04` and `CTL-01`
- `docs.auto_generated_docs`: `Phase 1` via `CTL-04`
- `docs.docs_as_code`: `Phase 1` via `CTL-04`
- `docs.readme_freshness`: `Phase 1` via `CTL-01`
- `docs.agents_md_freshness`: `Phase 1` via `CTL-01`
- `docs.spec_constitution`: `Phase 1` via `CTL-01`
- `docs.spec_md`: `Phase 1` via `CTL-01`
- `docs.spec_plans`: `Phase 1` via `FND-01` and `CTL-01`
- `docs.spec_contracts_openapi`: `Later` via future framework API/export contract work
- `docs.spec_tasks`: `Phase 1` via `CTL-01` and `CTL-03`
- `docs.frozen_contracts`: `Phase 1` via `KRN-01`, `CFG-01`, and `CTL-05`

## Code Style

- `style.editorconfig`: `Phase 1` via `FND-03`
- `style.linter_config`: `Phase 1` via `FND-03`
- `style.type_checking`: `Phase 1` via `FND-03`
- `style.precommit_hooks`: `Phase 1` via `FND-03`

## Build

- `build.package_manifest`: `Phase 1` via `FND-02`
- `build.scripts`: `Phase 1` via `FND-03`
- `build.lock_file`: `Phase 1` via `FND-03`
- `build.github_workflow`: `Phase 1` via `CTL-02`
- `build.push_trigger`: `Phase 1` via `CTL-02`
- `build.pr_trigger`: `Phase 1` via `CTL-02`
- `build.checkout_action`: `Phase 1` via `CTL-02`
- `build.ci_required_checks`: `Phase 1` via `CTL-02`
- `build.canary_deployment`: `Later` via deployment/reference-service work
- `build.rollback_automation`: `Later` via deployment/reference-service work
- `build.vcs_cli_tools`: `Later / External` via maintainer environment and optional docs

## Testing

- `test.test_files`: `Phase 1` via `KRN-01` to `TRN-03`
- `test.config`: `Phase 1` via `FND-03`
- `test.integration_tests`: `Phase 1` via `TRN-03` and `CTL-05`
- `test.contract_tests`: `Phase 1` via `KRN-01`, `CFG-01`, and `CTL-05`
- `test.mutation_testing`: `Later` via `CTL-05`
- `test.property_based_testing`: `Later` via `CTL-05`

## Security

- `security.gitignore`: `Phase 1` via `FND-03`
- `security.gitignore_secrets`: `Phase 1` via `FND-03` and `CTL-06`
- `security.dependabot`: `Phase 1` via `CTL-06`
- `security.codeowners`: `Phase 1` via `CTL-06`
- `security.sast_integrated`: `Later` via `CTL-06`
- `security.sbom_generation`: `Later` via `CTL-06`

## Observability

- `observability.logging`: `Phase 1` via `INF-05`
- `observability.tracing`: `Phase 1` via `INF-05`
- `observability.metrics`: `Later` via `DEF-06`

## Environment

- `env.dotenv_example`: `Later` because config is file-first, but any required env integrations should still be documented
- `env.devcontainer`: `Later` via `FND-03`
- `env.docker_compose`: `Later` if local infrastructure examples become necessary beyond SQLite/in-memory defaults

## Task Discovery

- `task_discovery.issue_templates`: `Phase 1` via `CTL-03`
- `task_discovery.pr_template`: `Phase 1` via `CTL-03`
- `task_discovery.task_queue`: `Phase 1` via `CTL-03`

## Product

- `product.feature_flags`: `Later` as framework-consumer or optional plugin work
- `product.analytics`: `Later` as framework-consumer or optional plugin work
- `product.ab_testing`: `Later` as framework-consumer or optional plugin work

## Agent Config

- `agent_config.agents_md`: `Phase 1` via `CTL-01`
- `agent_config.gitignore_agent`: `Phase 1` via `CTL-01` and `CTL-06`
- `agent_config.basic_instructions`: `Phase 1` via `CTL-01`
- `agent_config.claude_settings`: `Later / External` depending on chosen local workflows
- `agent_config.claude_commands`: `Later / External` depending on chosen local workflows
- `agent_config.cursorrules`: `Later / External` depending on chosen local workflows
- `agent_config.aider_config`: `Later / External` depending on chosen local workflows
- `agent_config.copilot_config`: `Later / External` depending on chosen local workflows
- `agent_config.windsurf_rules`: `Later / External` depending on chosen local workflows
- `agent_config.mcp_json`: `Phase 1` via `CAP-03` and `CTL-01`
- `agent_config.mcp_server_config`: `Phase 1` via `CAP-03`
- `agent_config.mcp_tools_defined`: `Phase 1` via `CAP-01`, `CAP-02`, `CAP-03`, `CAP-04`, `CAP-05`, `CAP-06`, `CAP-07`
- `agent_config.claude_hooks`: `Later / External` depending on chosen local workflows
- `agent_config.multi_agent_support`: `Phase 1` via `KRN-04`, `CAP-05`, and `TRN-03`
- `agent_config.context_injection`: `Phase 1` via `KRN-03`, `CFG-02`, `CAP-04`, and `CAP-07`
- `agent_config.agent_permissions`: `Later` via deferred governance/runtime hardening work (see `docs/runtime-governance.md`)
- `agent_config.autonomous_workflow`: `Later` via mature multi-agent workflow orchestration
- `agent_config.self_improvement`: `Later` via roadmaped self-improvement/feedback-loop planning
- `agent_config.speckit_commands`: `Later / External` unless the repo adopts spec-kit slash-command conventions
- `agent_config.agent_boundaries`: `Phase 1` via `CTL-03`
- `agent_config.ownership_map`: `Phase 1` via `CTL-03`
- `agent_config.conflict_detection`: `Later` via `CTL-03` and later multi-agent control work

## Code Quality

- `code_quality.complexity_config`: `Later` via `CTL-07`
- `code_quality.coverage_config`: `Phase 1` via `CTL-05` and `CTL-07`
- `code_quality.duplication_detection`: `Later` via `CTL-07`
- `code_quality.tech_debt_tracking`: `Phase 1` via `CTL-07`

## Notes On Applicability

Some checks in `agent-ready` assume a deployed web service or vendor-specific local agent tooling. This framework should still track them, but not all of them need to be satisfied by the first code drop.

Important examples:

- `build.canary_deployment` and `build.rollback_automation` are more naturally satisfied once there is a deployment-bearing reference service or production deployment path.
- several `agent_config.*` checks are intentionally tool-specific for local AI clients. Those can be adopted later or documented as optional ecosystem integrations.
- `docs.spec_contracts_openapi` is likely to become relevant once the Hono plugin exposes a stabilized API surface worth freezing as contracts.

## Recommended Linear Handling

Use this mapping in Linear as follows:

- treat `Phase 1` checks as part of the first implementation/control-plane push
- treat `Later` checks as planned backlog items with explicit parent issues
- treat `Later / External` checks as tracked obligations with clear notes about where they are expected to be satisfied
