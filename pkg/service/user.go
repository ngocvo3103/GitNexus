package service

import (
	"example.com/testapp/pkg/repository"
)

func FindUser(id string) map[string]interface{} {
	return repository.GetByID(id)
}

func CreateUser(data map[string]string) map[string]interface{} {
	repository.Save(data)
	return map[string]interface{}{"created": true}
}
