// Signed-in profile editor: per-section saves so a failure in one section
// never blocks another. Demographics are ALL optional — empty saves as null.
// Email is absent from updateProfile by design (verified round-trip only).
import { ClassicyButton, ClassicyControlLabel, ClassicyInput, ClassicyPopUpMenu, ClassicyTabs } from "classicy";
import type { ChangeEvent, ReactNode } from "react";
import { useState } from "react";
import type React from "react";
import { useAuth } from "../../Providers/Auth/AuthContext";
import { UsernameTakenError, requestEmailChange, updateProfile } from "../../Providers/Auth/profileApi";
import styles from "./Account.module.scss";

const EDUCATOR_ROLES = [
	{ value: "", label: "—" },
	{ value: "teacher", label: "Teacher" },
	{ value: "librarian", label: "Librarian" },
	{ value: "professor", label: "Professor" },
	{ value: "homeschool", label: "Homeschool" },
	{ value: "museum_educator", label: "Museum Educator" },
	{ value: "administrator", label: "Administrator" },
	{ value: "other", label: "Other" },
];
const GRADE_LEVELS: [string, string][] = [
	["elementary", "Elementary"],
	["middle", "Middle"],
	["high_school", "High School"],
	["college", "College"],
	["adult", "Adult"],
];
const SUBJECTS: [string, string][] = [
	["us_history", "US History"],
	["world_history", "World History"],
	["social_studies", "Social Studies"],
	["civics", "Civics"],
	["english", "English"],
	["journalism", "Journalism"],
	["media_studies", "Media Studies"],
	["stem", "STEM"],
	["other", "Other"],
];

const orNull = (s: string): string | null => (s.trim() === "" ? null : s.trim());

/** Toggle-button multi-select built from depressed ClassicyButtons. */
const ToggleGroup: React.FC<{
	options: [string, string][];
	selected: string[];
	onToggle: (value: string) => void;
	disabled: boolean;
}> = ({ options, selected, onToggle, disabled }) => (
	<div className={styles.toggleGroup}>
		{options.map(([value, label]) => (
			<ClassicyButton
				key={value}
				buttonSize="small"
				depressed={selected.includes(value)}
				disabled={disabled}
				onClickFunc={() => onToggle(value)}
			>
				{label}
			</ClassicyButton>
		))}
	</div>
);

export // Match what the backfill produced, so a name typed here cannot differ from one
// assigned automatically only by case or punctuation. Directus enforces
// uniqueness, so a clash surfaces as a save error rather than silently taking
// someone else's name.
function normalizeUsername(raw: string): string {
	return raw
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "")
		.slice(0, 24);
}

export // Shape only. Availability is deliberately NOT checked here: a user can read
// just their own row, so a lookup would return zero rows for every name and
// report "available" for one already taken. The save is the real check.
function usernameProblem(name: string): string | null {
	if (name === "") return null; // clearing it is allowed; the backend falls back
	if (name.length < 3) return "Screen names need at least 3 characters.";
	if (/^[0-9]+$/.test(name)) return "Screen names need at least one letter.";
	return null;
}

export const ProfileEditor: React.FC = () => {
	const { user, refresh } = useAuth();

	// Section state snapshots `user` at MOUNT only (Account mounts this once
	// per signed-in session). If a reset/cancel feature is ever added, these
	// inits must become effects keyed on the relevant user fields.

	// Names
	const [firstName, setFirstName] = useState(user?.first_name ?? "");
	const [lastName, setLastName] = useState(user?.last_name ?? "");
	const [username, setUsername] = useState(user?.username ?? "");
	const [namesBusy, setNamesBusy] = useState(false);
	const [namesMsg, setNamesMsg] = useState<string | null>(null);

	// About you
	const [city, setCity] = useState(user?.city ?? "");
	const [stateRegion, setStateRegion] = useState(user?.state ?? "");
	const [country, setCountry] = useState(user?.country ?? "");
	const [school, setSchool] = useState(user?.school_name ?? "");
	const [educatorRole, setEducatorRole] = useState(user?.educator_role ?? "");
	const [gradeLevels, setGradeLevels] = useState<string[]>(user?.grade_levels ?? []);
	const [subjects, setSubjects] = useState<string[]>(user?.subjects ?? []);
	const [aboutBusy, setAboutBusy] = useState(false);
	const [aboutMsg, setAboutMsg] = useState<string | null>(null);

	// Email
	const [newEmail, setNewEmail] = useState("");
	const [confirmEmail, setConfirmEmail] = useState("");
	const [emailBusy, setEmailBusy] = useState(false);
	const [emailMsg, setEmailMsg] = useState<string | null>(null);

	// Password (default-provider accounts only)
	const [newPassword, setNewPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [passwordBusy, setPasswordBusy] = useState(false);
	const [passwordMsg, setPasswordMsg] = useState<string | null>(null);

	const toggle = (list: string[], set: (v: string[]) => void) => (value: string) =>
		set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

	const saveNames = () => {
		const cleaned = normalizeUsername(username);
		const problem = usernameProblem(cleaned);
		if (problem) {
			setNamesMsg(problem);
			return;
		}
		// Show what will actually be stored, so a name that lost characters to
		// normalising does not come back looking like a silent edit.
		if (cleaned !== username) setUsername(cleaned);
		setNamesBusy(true);
		setNamesMsg(null);
		updateProfile({
			first_name: orNull(firstName),
			last_name: orNull(lastName),
			username: orNull(cleaned),
		})
			.then(() => {
				setNamesMsg("Saved.");
				return refresh();
			})
			.catch((err: Error) => {
				// The database is the only authority on availability, so the
				// conflict arrives here rather than before the save. Offer a
				// name that is one step away instead of just refusing.
				if (err instanceof UsernameTakenError) {
					const suggestion = `${err.username}${Math.floor(Math.random() * 90) + 10}`;
					setUsername(suggestion);
					setNamesMsg(`"${err.username}" is taken. Try ${suggestion}, or pick your own.`);
					return;
				}
				setNamesMsg(err.message);
			})
			.finally(() => setNamesBusy(false));
	};

	const saveAbout = () => {
		setAboutBusy(true);
		setAboutMsg(null);
		updateProfile({
			city: orNull(city),
			state: orNull(stateRegion),
			country: orNull(country),
			school_name: orNull(school),
			educator_role: educatorRole === "" ? null : educatorRole,
			grade_levels: gradeLevels.length > 0 ? gradeLevels : null,
			subjects: subjects.length > 0 ? subjects : null,
		})
			.then(() => {
				setAboutMsg("Saved.");
				return refresh();
			})
			.catch((err: Error) => setAboutMsg(err.message))
			.finally(() => setAboutBusy(false));
	};

	const sendEmailLink = () => {
		setEmailMsg(null);
		if (newEmail.trim() !== confirmEmail.trim()) {
			setEmailMsg("Email addresses do not match.");
			return;
		}
		setEmailBusy(true);
		requestEmailChange(newEmail.trim())
			.then(() => setEmailMsg("Confirmation link sent — check your new inbox."))
			.catch((err: Error) => setEmailMsg(err.message))
			.finally(() => setEmailBusy(false));
	};

	const setPassword = () => {
		setPasswordMsg(null);
		if (newPassword.length < 8) {
			setPasswordMsg("Password must be at least 8 characters.");
			return;
		}
		if (newPassword !== confirmPassword) {
			setPasswordMsg("Passwords do not match.");
			return;
		}
		setPasswordBusy(true);
		updateProfile({ password: newPassword })
			.then(() => {
				setPasswordMsg("Password updated.");
				setNewPassword("");
				setConfirmPassword("");
			})
			.catch((err: Error) => setPasswordMsg(err.message))
			.finally(() => setPasswordBusy(false));
	};

	// Grouped into Classicy tabs so each concern (name, demographics, email,
	// password) is one uncluttered panel. Password is default-provider only,
	// so it's appended conditionally rather than rendered-then-hidden.
	const tabs: { title: string; children: ReactNode }[] = [
		{
			title: "Profile",
			children: (
				<div className={styles.tabPanel}>
					<ClassicyInput
						id="profile-first-name"
						labelTitle="First Name"
						prefillValue={firstName}
						disabled={namesBusy}
						onChangeFunc={(e) => setFirstName(e.target.value)}
					/>
					<ClassicyInput
						id="profile-last-name"
						labelTitle="Last Name"
						prefillValue={lastName}
						disabled={namesBusy}
						onChangeFunc={(e) => setLastName(e.target.value)}
					/>
					<ClassicyInput
						id="profile-username"
						labelTitle="Screen Name"
						prefillValue={username}
						disabled={namesBusy}
						onChangeFunc={(e) => setUsername(e.target.value)}
					/>
					<div className={styles.hint}>
						This is what your buddies call you in chat. Lowercase letters, numbers and
						underscores.
					</div>
					<ClassicyButton disabled={namesBusy} onClickFunc={saveNames}>
						Save Names
					</ClassicyButton>
					{namesMsg && <div>{namesMsg}</div>}
				</div>
			),
		},
		{
			title: "About You",
			children: (
				<div className={styles.tabPanel}>
					<ClassicyInput
						id="profile-city"
						labelTitle="City"
						prefillValue={city}
						disabled={aboutBusy}
						onChangeFunc={(e) => setCity(e.target.value)}
					/>
					<ClassicyInput
						id="profile-state"
						labelTitle="State"
						prefillValue={stateRegion}
						disabled={aboutBusy}
						onChangeFunc={(e) => setStateRegion(e.target.value)}
					/>
					<ClassicyInput
						id="profile-country"
						labelTitle="Country"
						prefillValue={country}
						disabled={aboutBusy}
						onChangeFunc={(e) => setCountry(e.target.value)}
					/>
					<ClassicyInput
						id="profile-school"
						labelTitle="School"
						prefillValue={school}
						disabled={aboutBusy}
						onChangeFunc={(e) => setSchool(e.target.value)}
					/>
					<ClassicyPopUpMenu
						id="profile-educator-role"
						label="Educator Role"
						labelPosition="left"
						options={EDUCATOR_ROLES}
						selected={educatorRole}
						onChangeFunc={(e: ChangeEvent<HTMLSelectElement>) =>
							setEducatorRole(e.target.value)
						}
					/>
					<ToggleGroup
						options={GRADE_LEVELS}
						selected={gradeLevels}
						onToggle={toggle(gradeLevels, setGradeLevels)}
						disabled={aboutBusy}
					/>
					<ToggleGroup
						options={SUBJECTS}
						selected={subjects}
						onToggle={toggle(subjects, setSubjects)}
						disabled={aboutBusy}
					/>
					<ClassicyButton disabled={aboutBusy} onClickFunc={saveAbout}>
						Save Profile
					</ClassicyButton>
					{aboutMsg && <div>{aboutMsg}</div>}
				</div>
			),
		},
		{
			title: "Email",
			children: (
				<div className={styles.tabPanel}>
					<ClassicyControlLabel label={`Email: ${user?.email ?? ""}`} />
					<ClassicyInput
						id="profile-new-email"
						labelTitle="New Email"
						prefillValue={newEmail}
						disabled={emailBusy}
						onChangeFunc={(e) => setNewEmail(e.target.value)}
					/>
					<ClassicyInput
						id="profile-confirm-email"
						labelTitle="Confirm New Email"
						prefillValue={confirmEmail}
						disabled={emailBusy}
						onChangeFunc={(e) => setConfirmEmail(e.target.value)}
					/>
					<ClassicyButton disabled={emailBusy} onClickFunc={sendEmailLink}>
						Send Confirmation Link
					</ClassicyButton>
					{emailMsg && <div>{emailMsg}</div>}
				</div>
			),
		},
	];

	if (user?.provider === "default") {
		tabs.push({
			title: "Password",
			children: (
				<div className={styles.tabPanel}>
					<ClassicyInput
						id="profile-new-password"
						labelTitle="New Password"
						type="password"
						prefillValue={newPassword}
						disabled={passwordBusy}
						onChangeFunc={(e) => setNewPassword(e.target.value)}
					/>
					<ClassicyInput
						id="profile-confirm-password"
						labelTitle="Confirm Password"
						type="password"
						prefillValue={confirmPassword}
						disabled={passwordBusy}
						onChangeFunc={(e) => setConfirmPassword(e.target.value)}
					/>
					<ClassicyButton disabled={passwordBusy} onClickFunc={setPassword}>
						Set Password
					</ClassicyButton>
					{passwordMsg && <div>{passwordMsg}</div>}
				</div>
			),
		});
	}

	return <ClassicyTabs tabs={tabs} />;
};
