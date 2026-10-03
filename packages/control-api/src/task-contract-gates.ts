import {
  AccessProfile,
  FrozenTaskContractArtifact,
  TestCommandGrant,
  type TaskContract,
} from "@claudexor/schema";
import type { verifyAndDeliver } from "@claudexor/delivery";
import { parse as parseYaml } from "yaml";

const unverifiable = (message: string) =>
  Object.assign(new Error(message), { status: 409, code: "task_contract_unverifiable" });

/** Recover the exact frozen gate set; absent/corrupt authority is never an empty set. */
export function requiredGateSpecsFromTaskArtifact(
  raw: string | null,
): NonNullable<Parameters<typeof verifyAndDeliver>[3]> {
  if (raw === null) throw unverifiable("run is missing its required task contract");
  let task: TaskContract;
  try {
    task = FrozenTaskContractArtifact.parse(parseYaml(raw));
  } catch {
    throw unverifiable("run task contract is malformed or unverifiable");
  }
  const access = AccessProfile.safeParse(task.access.effective_profile);
  if (!access.success) throw unverifiable("run task contract uses a retired access profile");
  return task.tests.commands.map((command) => {
    const grant =
      command.trust_grant === null ? null : TestCommandGrant.safeParse(command.trust_grant);
    if (grant !== null && !grant.success) {
      throw unverifiable("run task contract contains a retired test-command grant");
    }
    return {
      id: command.id,
      program: command.program,
      args: command.args,
      cwd: command.cwd,
      envAllowlist: command.envAllowlist,
      trustRequired: command.trust_required,
      trustGrant: grant === null ? null : grant.data,
      projectRoot: task.repo.root,
      accessProfile: access.data,
      required: command.required,
    };
  });
}
