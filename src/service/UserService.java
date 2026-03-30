package service;

import repository.UserRepository;
import service.Validator;

public class UserService {
    private UserRepository repository = new UserRepository();
    private Validator validator = new Validator();

    public Object findUser(String id) {
        validator.validate(id);
        return repository.getById(id);
    }

    public Object createUser(String name) {
        validator.validate(name);
        return repository.save(name);
    }
}
