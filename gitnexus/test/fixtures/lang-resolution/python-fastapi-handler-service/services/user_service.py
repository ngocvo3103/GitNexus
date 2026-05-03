from typing import List


class UserService:
    def __init__(self):
        self._users: List[dict] = []

    def get_users(self) -> List[dict]:
        return self._users

    def create_user(self, data: dict) -> dict:
        user = {"id": len(self._users) + 1, **data}
        self._users.append(user)
        return user


def get_user_service() -> UserService:
    return UserService()