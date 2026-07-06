# New Tools for Brittain Code

## Enhanced File Operations

### 1. `append_file`
- **Description**: Append content to a text file. Creates the file if it does not exist.
- **Parameters**: `path` (file path), `content` (text to append)
- **Use Case**: Adding to log files, appending to configuration files

### 2. `create_directory`
- **Description**: Create a new directory. Creates parent directories as needed.
- **Parameters**: `path` (directory path to create)
- **Use Case**: Setting up project structures, organizing files

### 3. `delete_file`
- **Description**: Delete a file. Returns success message or error.
- **Parameters**: `path` (file path to delete)
- **Use Case**: Cleaning up temporary files, removing obsolete code

### 4. `copy_file`
- **Description**: Copy a file from source to destination.
- **Parameters**: `source` (source file path), `destination` (destination file path)
- **Use Case**: Backing up files, duplicating configuration files

### 5. `move_file`
- **Description**: Move/rename a file from source to destination.
- **Parameters**: `source` (source file path), `destination` (destination file path)
- **Use Case**: Renaming files, reorganizing project structure

### 6. `file_info`
- **Description**: Get information about a file including size, modification time, and permissions.
- **Parameters**: `path` (file path to get info for)
- **Use Case**: Debugging, file analysis, system monitoring

### 7. `get_file_lines`
- **Description**: Get specific lines from a file. Returns lines as an array.
- **Parameters**: `path` (file path), `start` (starting line number), `end` (ending line number)
- **Use Case**: Extracting code snippets, analyzing specific parts of files

### 8. `count_lines`
- **Description**: Count lines in a file.
- **Parameters**: `path` (file path)
- **Use Case**: Code complexity analysis, project statistics

### 9. `get_file_type`
- **Description**: Determine the file type based on its content or extension.
- **Parameters**: `path` (file path)
- **Use Case**: File categorization, language-specific operations

### 10. `replace_in_file`
- **Description**: Replace text in a file using regex or literal replacement.
- **Parameters**: `path` (file path), `pattern` (text or regex to find), `replacement` (replacement text), `flags` (regex flags)
- **Use Case**: Code refactoring, configuration updates

## Enhanced Search & Find Operations

### 11. `search_in_file`
- **Description**: Search for a text pattern in a specific file and return matching lines with line numbers.
- **Parameters**: `path` (file path), `pattern` (text or regex to search for)
- **Use Case**: Finding specific code patterns within files

### 12. `find_files`
- **Description**: Find files matching a pattern in the working directory. Supports glob patterns.
- **Parameters**: `pattern` (glob pattern), `path` (directory to search in)
- **Use Case**: Finding all JavaScript files, locating configuration files

### 13. `find_largest_files`
- **Description**: Find the largest files in a directory.
- **Parameters**: `path` (directory path to search in), `count` (number of largest files to return)
- **Use Case**: Disk space analysis, identifying large files

## Integration Benefits

These new tools significantly expand Brittain Code's capabilities by:

1. **Enhanced File Management**: Full CRUD operations for files and directories
2. **Better Text Manipulation**: Advanced search and replace functionality
3. **Improved Debugging**: File information and line-based operations
4. **System Analysis**: Finding large files, understanding project structure
5. **Code Refactoring**: Precise text replacement in files
6. **Project Organization**: Creating directories, copying/moving files

## Risk Assessment

The following tools are considered "risky" and require user approval:
- `append_file`
- `create_directory` 
- `delete_file`
- `copy_file`
- `move_file`
- `replace_in_file`

These tools are added to the `RISKY_TOOLS` set to ensure user consent before execution, maintaining the security model of the application.