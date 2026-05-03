package main

type OrderService struct{}

func (s *OrderService) GetOrder() string {
	return "order-123"
}