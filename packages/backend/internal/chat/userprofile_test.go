package chat

import "testing"

func TestExposableFieldAcceptsAConfiguredColumn(t *testing.T) {
	columns := map[string]bool{"city": true, "school_name": true}
	for _, name := range []string{"city", "school_name"} {
		if !ExposableField(name, columns) {
			t.Errorf("ExposableField(%q) = false, want true", name)
		}
	}
}

func TestExposableFieldRejectsWhatItMust(t *testing.T) {
	// Every column below EXISTS on directus_users, so `columns` cannot be what
	// rejects them -- each case has to be caught by the regex or the denylist.
	columns := map[string]bool{
		"city": true, "password": true, "token": true, "tfa_secret": true,
		"auth_data": true, "email": true, "filesystem": true, "avatar": true,
		"role": true, "status": true, "id": true, "policies": true,
		"external_identifier": true,
	}
	cases := []struct {
		name, field string
	}{
		{"a password never leaves the database", "password"},
		{"nor a static access token", "token"},
		{"nor a TFA secret", "tfa_secret"},
		{"nor the SSO auth blob", "auth_data"},
		{"nor the external identity", "external_identifier"},
		{"nor the email address", "email"},
		{"nor the filesystem blob pointer", "filesystem"},
		{"nor the avatar file id", "avatar"},
		{"nor role/status/policies/id", "policies"},
		{"uppercase is not a column name we write", "City"},
		{"nor is a quoted injection attempt", `city" , "password`},
		{"nor a semicolon", "city; DROP TABLE directus_users"},
		{"nor a leading digit", "1city"},
		{"nor empty", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if ExposableField(c.field, columns) {
				t.Errorf("ExposableField(%q) = true, want false", c.field)
			}
		})
	}
}

func TestExposableFieldRejectsAColumnThatDoesNotExist(t *testing.T) {
	// A config row naming a column nobody ever created must be dropped, not
	// interpolated into a SELECT that would then fail for every user.
	if ExposableField("favourite_colour", map[string]bool{"city": true}) {
		t.Error("ExposableField accepted a nonexistent column")
	}
}
