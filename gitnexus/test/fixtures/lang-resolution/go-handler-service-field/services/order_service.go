package services

type OrderService struct{}

func (s *OrderService) GetOrder(id int) string {
	return "order"
}