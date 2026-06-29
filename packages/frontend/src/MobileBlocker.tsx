import { ClassicyIcons } from "classicy";
import "./MobileBlocker.css";

export const MobileBlocker = () => (
	<div className="mobileBlocker">
		<div className="mobileBlockerDialog">
			<div className="mobileBlockerTitleBar">
				<span>Notice</span>
			</div>
			<div className="mobileBlockerBody">
				<img
					src={ClassicyIcons.system.error}
					alt=""
					aria-hidden="true"
					className="mobileBlockerIcon"
				/>
				<p className="mobileBlockerText">
					This application works best on the Desktop. Please open the site on
					your computer.
				</p>
			</div>
		</div>
	</div>
);
