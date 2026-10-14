// After `companion-module-build`, mirror the package from pkg/<id>/ into pkg/ itself and make sure the
// DEBUG-PACKAGED marker exists. Companion's developer modules folder then runs this repo from the packaged build
// (it looks for pkg/companion/manifest.json), so no node_modules or dist/ are needed on the Companion machine.
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync('companion/manifest.json', 'utf8'))
const inner = `pkg/${manifest.id}`
if (!existsSync(inner)) {
	console.error(`${inner} not found - run companion-module-build first`)
	process.exitCode = 1
} else {
	cpSync(inner, 'pkg', { recursive: true })
	if (!existsSync('DEBUG-PACKAGED')) writeFileSync('DEBUG-PACKAGED', '')
	console.log(`Developer layout ready: pkg/ mirrors ${inner} (DEBUG-PACKAGED set)`)
}
