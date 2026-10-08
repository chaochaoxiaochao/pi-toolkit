# Pi Toolkit

Pi Toolkit develops editing extensions and evaluates whether their tool protocols improve exact file-editing outcomes without weakening mutation safety.

## Language

**Agent Benchmark**:
A model-driven comparison in which isolated agents receive the same editing tasks and their complete workspaces are verified byte for byte.
_Avoid_: Parser benchmark, unit benchmark

**Protocol Regression**:
A deterministic fixture that exercises one editing-protocol behavior directly, without model sampling.
_Avoid_: Benchmark task, model comparison

**Safety Regression**:
A Protocol Regression whose correct outcome is rejection with no workspace mutation.
_Avoid_: Failed edit, failed benchmark

**First Exact**:
An Agent Benchmark task whose complete workspace matches the expected bytes after the initial agent round.
_Avoid_: First-call success

**Final Exact**:
An Agent Benchmark task whose complete workspace matches the expected bytes after the permitted recovery rounds.
_Avoid_: Eventual success

**Recovery**:
A continuation in the same Agent Benchmark session and workspace after verifier feedback; it is not an independent observation.
_Avoid_: Retry, rerun

**Paired Regression**:
An Agent Benchmark task passed by a baseline arm and failed by the local arm under the same frozen task manifest.
_Avoid_: Safety Regression

**Neutral Cohort**:
The 80-task proportional sample that preserves the Explicit Edit task-family distribution.
_Avoid_: Random tasks

**Challenge Cohort**:
The 20-task declared supplement that increases coverage of selection, multi-file, cross-file, block, literal, and Unicode editing risks.
_Avoid_: Hand-picked wins
