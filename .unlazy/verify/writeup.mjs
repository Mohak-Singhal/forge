// G8: the write-up contains the eight required headings, in order.
// Reads the HTML source of the PDF so a heading cannot be lost in the PDF export
// without failing here first.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const file = join(process.cwd(), "report", "forge-writeup.html")
if (!existsSync(file)) {
	console.error(`FAIL missing ${file}`)
	process.exit(1)
}
const html = readFileSync(file, "utf8")
const headings = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((m) =>
	m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
)

// Required order and the keyword each heading must contain (case-insensitive).
const required = [
	["Team", /team/i],
	["Starting point", /starting point/i],
	["Architecture on TrueForge", /architecture/i],
	["How context is selected", /context/i],
	["Model setup", /model/i],
	["Scorecard", /scorecard/i],
	["Tools used", /tools/i],
	["Known limitations", /limitations/i],
]

const problems = []
let cursor = 0
for (const [label, pattern] of required) {
	const index = headings.findIndex((heading, position) => position >= cursor && pattern.test(heading))
	if (index === -1) {
		problems.push(`missing heading: ${label}`)
		continue
	}
	cursor = index + 1
}
if (problems.length) {
	console.error(`FAIL ${problems.join("; ")}\nfound: ${headings.join(" | ")}`)
	process.exit(1)
}
console.log(`WRITEUP_OK ${required.length} headings in order: ${headings.join(" | ")}`)
