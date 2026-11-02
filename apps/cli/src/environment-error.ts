import type { ContractError } from "@bflow/contracts";

export class EnvironmentError extends Error {
  constructor(readonly contractError: ContractError) {
    super(contractError.message);
  }
}
