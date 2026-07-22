import type React from "react";
import readmeStyles from "./README.module.scss";
import { pillColors } from "./tagColors";
import type { ReadmeTag } from "./useReadmeArticles";

// A row of tag pills. Renders nothing when there are no tags.
export const TagPills: React.FC<{ tags: ReadmeTag[] }> = ({ tags }) => {
	if (tags.length === 0) return null;
	return (
		<span className={readmeStyles.pills}>
			{tags.map((t) => {
				const { background, text } = pillColors(t.color);
				return (
					<span
						key={t.id}
						className={readmeStyles.pill}
						style={{ backgroundColor: background, color: text }}
					>
						{t.name}
					</span>
				);
			})}
		</span>
	);
};
