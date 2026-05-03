package handlers

import "example.com/go-handler-service-field/services"

type OrderHandler struct {
	service *services.OrderService
}

func (h *OrderHandler) GetOrder() string {
	return h.service.GetOrder(1)
}