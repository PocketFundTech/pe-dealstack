/**
 * Picking a PDF, an Excel file and two .txt files showed only the PDF and
 * Excel file in the confirm dialog: the .txt files were dropped, and the
 * per-file error toasts were hidden behind the dialog (live QA 2026-09-30).
 * The dialog now lists what was skipped and why.
 */
import { describe, it, expect } from "vitest";
import { splitUploadFiles, MAX_UPLOAD_FILE_SIZE } from "./upload-helpers";

function file(name: string, type: string, size = 1024): File {
  const f = new File(["x"], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
}

describe("splitUploadFiles", () => {
  it("keeps supported files and reports each skipped file with its reason", () => {
    const { valid, skipped } = splitUploadFiles([
      file("cim.pdf", "application/pdf"),
      file("model.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
      file("notes.txt", "text/plain"),
      file("huge.pdf", "application/pdf", MAX_UPLOAD_FILE_SIZE + 1),
    ]);
    expect(valid.map((f) => f.name)).toEqual(["cim.pdf", "model.xlsx"]);
    expect(skipped).toEqual([
      { name: "notes.txt", reason: "unsupported file type" },
      { name: "huge.pdf", reason: "larger than 50MB" },
    ]);
  });
});
