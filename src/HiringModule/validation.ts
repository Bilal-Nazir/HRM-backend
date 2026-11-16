import { randomUUID } from "crypto";
import { ValidationException } from "../node-base/utils";

export function text(
  value: unknown,
  label: string,
  max: number,
  required = false,
) {
  if (value === undefined && !required) return "";
  if (
    typeof value !== "string" ||
    value.length > max ||
    (required && !value.trim())
  )
    throw new ValidationException(
      `${label} ${required ? "is required and " : ""}must be at most ${max} characters`,
    );
  return value.trim();
}
export function choice(value: unknown, values: string[], label: string) {
  if (typeof value !== "string" || !values.includes(value))
    throw new ValidationException(`Invalid ${label}`);
  return value;
}
export const pageStatuses = ["draft", "published", "closed", "archived"];
export const applicantStatuses = [
  "new",
  "reviewing",
  "shortlisted",
  "rejected",
  "hired",
];
export function pageInput(body: any, previous?: any) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ValidationException("Invalid hiring page");
  const input = { ...previous, ...body };
  const title = text(input.title, "Job title", 160, true);
  const description = text(input.description, "Job description", 30000);
  const status = choice(input.status || "draft", pageStatuses, "page status");
  if (status === "published" && !description)
    throw new ValidationException("Add a job description before publishing");
  const questions = input.questions || [];
  if (!Array.isArray(questions) || questions.length > 6)
    throw new ValidationException("Add at most 6 application questions");
  const known = new Set((previous?.questions || []).map((q: any) => q.id));
  const mapped = questions.map((q: any) => ({
    id: typeof q?.id === "string" && known.has(q.id) ? q.id : randomUUID(),
    label: text(q?.label, "Question", 300, true),
    required: q?.required === true,
  }));
  if (new Set(mapped.map((q) => q.id)).size !== mapped.length)
    throw new ValidationException("Duplicate application questions");
  const accentColor = text(input.accentColor || "#0d9488", "Accent color", 7);
  if (!/^#[0-9a-f]{6}$/i.test(accentColor))
    throw new ValidationException("Choose a valid accent color");
  return {
    title,
    description,
    status,
    questions: mapped,
    accentColor,
    introduction: text(input.introduction, "Introduction", 500),
    location: text(input.location, "Location", 160),
    workMode: choice(
      input.workMode || "On-site",
      ["On-site", "Hybrid", "Remote"],
      "workplace",
    ),
    employmentType: choice(
      input.employmentType || "Full-time",
      ["Full-time", "Part-time", "Contract", "Internship"],
      "employment type",
    ),
  };
}

export const MAX_CV_BYTES = 5 * 1024 * 1024;
export function cvInput(input: any) {
  const name = text(input?.name, "CV filename", 200, true).replace(
    /[^a-z\d ._()-]/gi,
    "_",
  );
  const base64 = input?.data;
  if (
    typeof base64 !== "string" ||
    base64.length > Math.ceil(MAX_CV_BYTES / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)
  )
    throw new ValidationException("Upload a PDF, DOC or DOCX CV up to 5 MB");
  const data = Buffer.from(base64, "base64");
  if (
    !data.length ||
    data.length > MAX_CV_BYTES ||
    data.toString("base64") !== base64
  )
    throw new ValidationException("Invalid CV file");
  let type = "";
  if (/\.pdf$/i.test(name) && data.subarray(0, 5).toString() === "%PDF-")
    type = "application/pdf";
  if (
    /\.doc$/i.test(name) &&
    data.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex"))
  )
    type = "application/msword";
  // Inspect ZIP central-directory filenames without inflating untrusted data.
  if (
    /\.docx$/i.test(name) &&
    data.length >= 4 &&
    data.readUInt32LE(0) === 0x04034b50
  ) {
    const end = data.lastIndexOf(Buffer.from("504b0506", "hex"));
    if (end >= 0 && end + 22 <= data.length) {
      const count = data.readUInt16LE(end + 10),
        names = new Set<string>();
      let pos = data.readUInt32LE(end + 16);
      if (count <= 10000)
        for (let i = 0; i < count && pos + 46 <= end; i++) {
          if (data.readUInt32LE(pos) !== 0x02014b50) break;
          const length = data.readUInt16LE(pos + 28),
            extra = data.readUInt16LE(pos + 30),
            comment = data.readUInt16LE(pos + 32);
          if (pos + 46 + length + extra + comment > end) break;
          names.add(data.subarray(pos + 46, pos + 46 + length).toString());
          pos += 46 + length + extra + comment;
        }
      if (
        names.has("word/document.xml") &&
        names.has("[Content_Types].xml") &&
        pos === end
      )
        type =
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }
  }
  if (!type)
    throw new ValidationException(
      "The CV must be a valid PDF, DOC or DOCX file",
    );
  return { cvName: name, cvType: type, cvSize: data.length, cvData: data };
}
