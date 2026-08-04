def greet(name):
    if not name:
        raise ValueError("name must not be empty")
    return f"Hello, {name}!"


if __name__ == "__main__":
    print(greet("world"))
