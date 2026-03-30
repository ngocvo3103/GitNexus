package main

import (
	"example.com/testapp/pkg/handler"
)

func main() {
	handler.HandleGet("1")
	handler.HandlePost(map[string]string{"name": "test"})
}
