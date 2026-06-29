import { ClassicyControlLabel, ClassicyIcons, ClassicyWindow } from "classicy";
import "./MobileBlocker.css";

const warningIcon = ClassicyIcons.system.error;

export const MobileBlocker = () => (
	<div className="mobileBlocker">
		<ClassicyWindow
			appId="Finder.app"
			id="mobile_warning"
			type="error"
			closable={false}
			resizable={false}
			zoomable={false}
			scrollable={false}
			collapsable={false}
			initialSize={[380, 0]}
			initialPosition={["center", "center"]}
		>
			<div
				style={{
					display: "flex",
					flexDirection: "row",
					alignItems: "flex-start",
					gap: "1rem",
					padding: "1rem",
				}}
			>
				<img
					src={warningIcon}
					alt="Warning"
					style={{ width: 32, height: 32, flexShrink: 0 }}
				/>
				<ClassicyControlLabel label="This application works best on the Desktop. Please open the site on your computer." />
			</div>
		</ClassicyWindow>
	</div>
);
