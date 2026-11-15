/** Display names. On-chain and file identifiers stay as they are; people read these. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "ZEROHOUR-DEMO-2026-11-15T16:21" -> "Demo exam, 15 Nov 2026" */
export function examTitle(name: string | null | undefined, id?: string): string {
  if (!name) return id ? `Exam ${id.slice(0, 10)}` : "Exam";
  const m = /^ZEROHOUR-([A-Z]+)-(\d{4})-(\d{2})-(\d{2})/.exec(name);
  if (!m) return name;
  const kind = m[1] === "DEMO" ? "Demo exam" : `${m[1][0]}${m[1].slice(1).toLowerCase()} exam`;
  return `${kind}, ${Number(m[4])} ${MONTHS[Number(m[3]) - 1]} ${m[2]}`;
}

/** "centre-pune-17" -> "Pune-17" */
export function centreLabel(name: string): string {
  const m = /^centre-([a-z]+)-(\d+)$/.exec(name);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)}-${m[2]}` : name.startsWith("0x") ? `${name.slice(0, 8)}…` : name;
}
