package service

func FormatResponse(data map[string]interface{}) map[string]interface{} {
	data["formatted"] = true
	return data
}

func ValidateInput(data map[string]string) bool {
	return len(data) > 0
}

func Sanitize(input string) string {
	return input
}
