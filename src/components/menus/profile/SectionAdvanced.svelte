<script lang="ts">
	import { getUserSettings } from "@/lib/services/userSettings.svelte.js";
	import { Wrench } from "lucide-svelte";
	import MenuCard from "@/components/menus/MenuCard.svelte";
	import Toggle from "@/components/ui/input/Toggle.svelte";
	import NumberInput from "@/components/ui/input/NumberInput.svelte";
	import * as m from "@/lib/paraglide/messages";
	import { onSettingsChange } from "@/lib/services/settings";
	import { getMap, handleRotatePitchDisable, resetMap } from "@/lib/map/map.svelte";
	import { isMenuSidebar } from "@/lib/utils/device";
</script>

<MenuCard title={m.settings_advanced()} Icon={Wrench}>
	{#if !isMenuSidebar()}
		<Toggle
			title={m.settings_left_handed_mode_title()}
			description={m.settings_left_handed_mode_description()}
			onclick={() => onSettingsChange("isLeftHanded", !getUserSettings().isLeftHanded)}
			value={getUserSettings().isLeftHanded}
		/>
	{/if}

	<Toggle
		title={m.settings_rotate_pitch_title()}
		description={m.settings_rotate_pitch_description()}
		onclick={() => {
			const newValue = !getUserSettings().enableRotatePitch;

			if (!newValue) {
				resetMap();
			}

			onSettingsChange("enableRotatePitch", newValue);
			const map = getMap();
			if (map) handleRotatePitchDisable(map);
		}}
		value={!getUserSettings().enableRotatePitch}
	/>

	<Toggle
		title={m.settings_search_below_weather_title()}
		description={m.settings_search_below_weather_description()}
		onclick={() => onSettingsChange("searchBelowWeather", !getUserSettings().searchBelowWeather)}
		value={getUserSettings().searchBelowWeather}
	/>

	<Toggle
		title={m.settings_load_map_objects_while_moving_title()}
		description={m.settings_load_map_objects_while_moving_description()}
		onclick={() =>
			onSettingsChange("loadMapObjectsWhileMoving", !getUserSettings().loadMapObjectsWhileMoving)}
		value={getUserSettings().loadMapObjectsWhileMoving}
	/>

	<NumberInput
		title={m.settings_load_map_objects_padding_title()}
		description={m.settings_load_map_objects_padding_description()}
		value={getUserSettings().loadMapObjectsPadding}
		onchange={(e) => onSettingsChange("loadMapObjectsPadding", parseFloat(e.target.value) || 0)}
		min="0"
		step="10"
	/>

	<Toggle
		title={m.settings_show_debug_title()}
		description={m.settings_show_debug_description()}
		onclick={() => onSettingsChange("showDebugMenu", !getUserSettings().showDebugMenu)}
		value={getUserSettings().showDebugMenu}
	/>
</MenuCard>
