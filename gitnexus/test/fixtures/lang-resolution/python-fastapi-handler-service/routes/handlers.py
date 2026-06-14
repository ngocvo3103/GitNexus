from typing import List

from services.user_service import UserService
from services.user_service import get_user_service
from services.order_service import OrderService
from services.order_service import get_order_service


def get_users(service: UserService = get_user_service()):
    return service.get_users()


def create_user(data: dict, service: UserService = get_user_service()):
    return service.create_user(data)


def get_order(order_id: int, service: OrderService = get_order_service()):
    return service.get_order(order_id)


def delete_order(order_id: int, service: OrderService = get_order_service()):
    service.delete_order(order_id)