import type {
	CompanionStaticUpgradeProps,
	CompanionStaticUpgradeResult,
	CompanionStaticUpgradeScript,
	CompanionUpgradeContext,
} from '@companion-module/base'
import type { ModuleConfig, ModuleSecrets } from './config.js'

export const UpgradeScripts: CompanionStaticUpgradeScript<ModuleConfig, ModuleSecrets>[] = [
	/*
	 * Place your upgrade scripts here
	 * Remember that once it has been added it cannot be removed!
	 */

	// v0.2: Arcadia support added a device type, defaulting to Arcadia. Connections created
	// before that are FreeSpeak II bases, so keep them on the FreeSpeak II driver
	function (
		_context: CompanionUpgradeContext<ModuleConfig>,
		props: CompanionStaticUpgradeProps<ModuleConfig, ModuleSecrets>,
	): CompanionStaticUpgradeResult<ModuleConfig, ModuleSecrets> {
		if (!props.config || props.config.deviceType) {
			return { updatedConfig: null, updatedActions: [], updatedFeedbacks: [] }
		}
		return {
			updatedConfig: { ...props.config, deviceType: 'fsii' },
			updatedActions: [],
			updatedFeedbacks: [],
		}
	},
]
