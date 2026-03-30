package repository;

public abstract class BaseRepository {
    public Object[] findAll() {
        return new Object[0];
    }

    public int count() {
        return 0;
    }
}
