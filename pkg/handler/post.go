package handler

import (
	"example.com/testapp/pkg/service"
)

func HandlePost(data map[string]string) map[string]interface{} {
	service.ValidateInput(data)
	return service.CreateUser(data)
}
