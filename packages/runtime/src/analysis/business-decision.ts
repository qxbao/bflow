import { z } from "zod";
import { ApprovalDecisionSchema, type ApprovalDecision } from "@bflow/contracts";

/** Derive facts from the original authenticated receipt; never rewrite that receipt or fill missing answers. */
export function analysisBusinessAnswers(input: ApprovalDecision,
  questions: readonly { id: string; blocking: boolean }[], answered: Readonly<Record<string, unknown>>): Record<string, string> {
  const decision = ApprovalDecisionSchema.parse(input);
  if (decision.decision !== "approved") return {};
  let answers: Record<string, string>;
  if (decision.metadata?.answers !== undefined) answers = z.record(z.string()).parse(decision.metadata.answers);
  else if (questions.every(question => Object.hasOwn(answered, question.id))) answers = {};
  else {
    const reason = decision.reason?.trim() ?? "";
    const entries = new Map<string, string>();
    const confirmation = /^(?:đồng ý|duyệt|xác nhận|approve|approved|user approved)[.!]?$/iu.test(reason);
    if (!confirmation) for (const line of reason.split(/\r?\n/u).filter(value => value.trim())) {
      const match = /^([A-Za-z][A-Za-z0-9._-]*)\s*:\s*(.+)$/u.exec(line.trim());
      if (!match || !match[2]!.trim()) throw new Error("Business answers cần ghi rõ mã câu hỏi: D-1: nội dung trả lời (mỗi câu một dòng)");
      if (entries.has(match[1]!)) throw new Error(`Conflicting business answers for question ${match[1]}`);
      entries.set(match[1]!, match[2]!.trim());
    }
    answers = Object.fromEntries(entries);
  }
  const unknown = Object.keys(answers).filter(id => !questions.some(question => question.id === id));
  if (unknown.length) throw new Error(`Unknown business questions: ${unknown.join(", ")}`);
  const missing = questions.filter(question => question.blocking && !Object.hasOwn(answered, question.id) &&
    (!Object.hasOwn(answers, question.id) || !answers[question.id]!.trim()));
  if (missing.length) throw new Error(`Required business answers are missing: ${missing.map(question => question.id).join(", ")}`);
  return answers;
}
