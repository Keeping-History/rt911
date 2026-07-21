import type { FC } from "react";
import { ClassicyCheckbox, ClassicyControlGroup } from "classicy";
import type { MapPoi } from "./mapPois";
import { distinctLayers } from "./mapPois";
import type { FlightPoiSettings } from "./flightMapSettings";
import styles from "./FlightTracker.module.scss";

interface FlightLayersPanelProps {
	pois: MapPoi[];
	settings: FlightPoiSettings;
	onChange: (next: FlightPoiSettings) => void;
}

// Live-apply (Filter Flights pattern): every checkbox change dispatches
// immediately via onChange — no working-copy/Save step.
export const FlightLayersPanel: FC<FlightLayersPanelProps> = ({ pois, settings, onChange }) => {
	const layers = distinctLayers(pois);
	const off = new Set(settings.disabledLayers);

	const toggleLayer = (layer: string, enabled: boolean) => {
		const next = new Set(off);
		if (enabled) next.delete(layer);
		else next.add(layer);
		onChange({ ...settings, disabledLayers: [...next] });
	};

	return (
		<div className={styles.settings}>
			<ClassicyControlGroup label="POI Layers">
				<ClassicyCheckbox
					id="flight_poi_master"
					label="Show POI layers"
					checked={settings.enabled}
					onClickFunc={(checked: boolean) => onChange({ ...settings, enabled: checked })}
				/>
				{layers.map((layer) => (
					<ClassicyCheckbox
						key={layer}
						id={`flight_poi_layer_${layer}`}
						label={layer}
						checked={!off.has(layer)}
						disabled={!settings.enabled}
						onClickFunc={(checked: boolean) => toggleLayer(layer, checked)}
					/>
				))}
				{layers.length === 0 && (
					<p className={styles.detailNote}>No POI layers available.</p>
				)}
			</ClassicyControlGroup>
		</div>
	);
};
