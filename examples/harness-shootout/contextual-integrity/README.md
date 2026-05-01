# Contextual Integrity Fixture

This deterministic benchmark profile models workspace privacy as contextual
information flow, not as a blanket deny list.

The fixture compares two candidates with the same task utility:

- `privacy-aware-agent` discloses the data classes required by the recipient,
  purpose, and transmission principle while withholding forbidden classes.
- `oversharing-agent` completes the useful task but leaks data classes that are
  forbidden for the current recipient and purpose.

The profile is evidence-only. It proves that the SDK can represent and report
contextual-integrity privacy outcomes for workspace agents; it does not claim a
live enterprise DLP system or external benchmark score movement.

