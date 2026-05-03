package main

type OrderHandler struct {
	service *OrderService
}

func (h *OrderHandler) GetOrder() {
	order := h.service.GetOrder()
	_ = order
}