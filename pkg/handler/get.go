package handler

import (
	"example.com/testapp/pkg/service"
)

func HandleGet(id string) map[string]interface{} {
	user := service.FindUser(id)
	return service.FormatResponse(user)
}
