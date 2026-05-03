from typing import Optional


class OrderService:
    def __init__(self):
        self._orders: dict[int, dict] = {}

    def get_order(self, order_id: int) -> Optional[dict]:
        return self._orders.get(order_id)

    def delete_order(self, order_id: int) -> None:
        self._orders.pop(order_id, None)


def get_order_service() -> OrderService:
    return OrderService()