mod auth;
mod data;

fn main() {
    let session = auth::login::login("user", "pass");
    let result = data::query::run_query("SELECT 1");
    println!("{:?} {:?}", session, result);
}
