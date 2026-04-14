# Canonical Run Envelope Contract

This contract freezes the minimal run envelope returned by the kernel and the
explicit output-plugin boundary used to finish a run.

## Envelope Shape

The kernel-owned envelope stays intentionally small:

- `kind: "run-envelope"`
- `runId`
- `rootScopeId`
- `rootAgentId?`
- `mode`
- `status`
- `timestamps`
- `eventStream?`
- `outputPluginId?`
- `output?`

The envelope is a control surface, not a final response schema. The kernel may
carry an output envelope through it, but the kernel does not interpret the
payload inside that envelope.

## Status And Time

Status is kernel-owned and limited to:

- `created`
- `running`
- `succeeded`
- `failed`
- `cancelled`

The timestamp block is also kernel-owned:

- `createdAt`
- `startedAt?`
- `completedAt?`
- `cancelledAt?`

## Event Stream Reference

The envelope may carry an opaque event-stream reference so future bootstrap and
run-mode wiring can surface the active canonical stream without forcing the
kernel to own a transport handle shape yet.

## Output-Plugin Boundary

The kernel only owns the boundary:

- it records the selected `outputPluginId`
- it passes the run to the output plugin for final shaping
- it stores the plugin-produced `output` envelope without interpreting the
  payload

Final payload semantics belong to the output plugin contract, not to the run
envelope.

## Kernel Integration Notes

The current scope models the contract and the core builder/finalizer helpers,
but the event/run-mode wiring is still being assembled in parallel. The next
integration step should thread this envelope through run bootstrap, session
completion, and the output plugin finalization path.
