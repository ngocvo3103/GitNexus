package repository

func GetByID(id string) map[string]interface{} {
	return map[string]interface{}{"id": id, "name": "Test"}
}

func Save(data map[string]string) bool {
	return true
}

func Delete(id string) bool {
	return true
}
